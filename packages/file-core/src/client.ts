import type { DataChannelManager } from '@ponter/webrtc-core';
import type {
  FilesAckMessage,
  FilesDownloadBegin,
  FilesDownloadEnd,
  FilesDownloadRequest,
  FilesErrorMessage,
  FilesListRequest,
  FilesListResult,
  FilesUploadBeginRequest,
  FilesUploadComplete,
  FilesUploadEndRequest,
  TransferDirection,
} from '@ponter/shared';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_WINDOW_SIZE,
  FILE_CHUNK_BYTES,
  TransferState,
  totalChunksFor,
} from './transfer';
import { FilesError, type FileClientErrorCode } from './errors';

/** The wire result minus the requestId the client consumed internally. */
export type FileListResult = Omit<FilesListResult, 'requestId'>;

export interface TransferProgress {
  transferId: string;
  direction: TransferDirection;
  bytesTransferred: number;
  totalBytes: number;
  /** Last contiguous chunk index (0-based; -1 before the first). */
  chunkIndex: number;
}

/** A handle returned by download()/upload(); progress via callbacks, abort via cancel(). */
export interface TransferHandle {
  readonly transferId: string;
  readonly direction: 'upload' | 'download';
  /** Resolves with the full payload (download: bytes; upload: nothing) or rejects with a FilesError. */
  readonly done: Promise<Uint8Array | void>;
  cancel(): void;
}

export interface FileClientOptions {
  /** Sliding-window size; default 16 (ADR-34). Test seam. */
  windowSize?: number;
  /** Idle timeout per transfer; default 30_000 ms (ADR-34). Test seam. */
  idleTimeoutMs?: number;
}

interface PendingList {
  resolve: (result: FileListResult) => void;
  reject: (error: FilesError) => void;
}

interface ActiveTransfer {
  state: TransferState;
  onProgress?: (progress: TransferProgress) => void;
  buffer: Uint8Array[];
  receivedBytes: number;
  declaredSize: number;
  /** True once files-upload-end has been sent (acks can still arrive after the last chunk). */
  ended?: boolean;
}

function mintId(): string {
  return crypto.randomUUID();
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i)!;
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++)
    binary += String.fromCodePoint(bytes[i]!);
  return btoa(binary);
}

export class FileClient {
  private readonly pendingLists = new Map<string, PendingList>();
  private readonly transfers = new Map<string, ActiveTransfer>();
  private readonly errorListeners: Array<
    (code: FileClientErrorCode, message: string) => void
  > = [];
  private readonly unsubscribeMessage: () => void;
  private readonly windowSize: number;
  private readonly idleTimeoutMs: number;
  private disposed = false;

  constructor(
    public readonly agentId: string,
    private readonly dataChannelManager: DataChannelManager,
    options?: FileClientOptions,
  ) {
    this.windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.unsubscribeMessage = this.dataChannelManager.onMessage(
      'files',
      (msg) => this.handleMessage(msg as { type: string; payload: unknown }),
    );
  }

  /** List a directory. Rejects with FilesError. */
  list(path: string): Promise<FileListResult> {
    this.assertLive();
    const requestId = mintId();
    return new Promise<FileListResult>((resolve, reject) => {
      this.pendingLists.set(requestId, {
        resolve: (result) => resolve(result),
        reject,
      });
      const payload: FilesListRequest = { requestId, path };
      this.sendJson('files-list', payload);
    });
  }

  /** Download a file; `onProgress` fires per accepted chunk. */
  download(
    path: string,
    onProgress?: (progress: TransferProgress) => void,
  ): TransferHandle {
    this.assertLive();
    const transferId = mintId();
    const state = new TransferState({
      transferId,
      direction: 'download',
      // Replaced from files-download-begin; 0 until then (pump is receive-side anyway).
      totalChunks: 0,
      size: 0,
      windowSize: this.windowSize,
      idleTimeoutMs: this.idleTimeoutMs,
      send: (frame) => {
        const { type, ...payload } = frame;
        this.sendJson(type, payload);
      },
    });
    const active: ActiveTransfer = {
      state,
      onProgress,
      buffer: [],
      receivedBytes: 0,
      declaredSize: 0,
    };
    this.transfers.set(transferId, active);
    state.armIdleTimer();
    this.sendJson('files-download', {
      transferId,
      path,
    } as FilesDownloadRequest);
    return {
      transferId,
      direction: 'download',
      done: state.settled as Promise<Uint8Array | void>,
      cancel: () => state.cancel(),
    };
  }

  /** Upload bytes into `dirPath` under `name` (a single component). */
  upload(
    dirPath: string,
    name: string,
    bytes: Uint8Array,
    onProgress?: (progress: TransferProgress) => void,
  ): TransferHandle {
    this.assertLive();
    const transferId = mintId();
    const totalChunks = totalChunksFor(bytes.byteLength);
    const state = new TransferState({
      transferId,
      direction: 'upload',
      totalChunks,
      size: bytes.byteLength,
      windowSize: this.windowSize,
      idleTimeoutMs: this.idleTimeoutMs,
      send: (frame) => {
        if (frame.type === 'files-upload-chunk') {
          // TransferState.pump() emits flat frames { type, chunkIndex };
          // access chunkIndex with a payload fallback for robustness.
          const chunkIndex =
            (frame.chunkIndex as number | undefined) ??
            ((frame.payload as Record<string, unknown> | undefined)
              ?.chunkIndex as number);
          const start = chunkIndex * FILE_CHUNK_BYTES;
          const slice = bytes.slice(start, start + FILE_CHUNK_BYTES);
          this.sendJson('files-upload-chunk', {
            transferId,
            chunkIndex,
            totalChunks,
            data: bytesToBase64(slice),
          });
          onProgress?.({
            transferId,
            direction: 'upload',
            bytesTransferred: Math.min(
              (chunkIndex + 1) * FILE_CHUNK_BYTES,
              bytes.byteLength,
            ),
            totalBytes: bytes.byteLength,
            chunkIndex,
          });
          return;
        }
        const { type, ...payload } = frame;
        this.sendJson(type, payload);
      },
    });
    const active: ActiveTransfer = {
      state,
      onProgress,
      buffer: [],
      receivedBytes: 0,
      declaredSize: bytes.byteLength,
    };
    this.transfers.set(transferId, active);
    state.armIdleTimer();

    const begin: FilesUploadBeginRequest = {
      transferId,
      path: dirPath,
      name,
      size: bytes.byteLength,
    };
    this.sendJson('files-upload-begin', begin);
    return {
      transferId,
      direction: 'upload',
      done: state.settled as Promise<Uint8Array | void>,
      cancel: () => state.cancel(),
    };
  }

  /** Subscribe to unsolicited errors (e.g. TRANSFER_TIMEOUT); returns an unsubscribe. */
  onError(
    handler: (code: FileClientErrorCode, message: string) => void,
  ): () => void {
    this.errorListeners.push(handler);
    return () => {
      const idx = this.errorListeners.indexOf(handler);
      if (idx >= 0) this.errorListeners.splice(idx, 1);
    };
  }

  /** Unsubscribe and reject all in-flight transfers with 'CANCELLED'. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeMessage();
    for (const [, transfer] of this.transfers) {
      transfer.state.dispose('CANCELLED');
    }
    this.transfers.clear();
    for (const [, pending] of this.pendingLists) {
      pending.reject(new FilesError('CANCELLED', 'client disposed'));
    }
    this.pendingLists.clear();
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new FilesError('CANCELLED', 'client disposed');
    }
  }

  private sendJson(
    type: string,
    payload: Record<string, unknown> | object,
  ): void {
    this.dataChannelManager.sendJson(
      'files',
      type,
      payload as Record<string, unknown>,
    );
  }

  private handleMessage(msg: { type: string; payload: unknown }): void {
    switch (msg.type) {
      case 'files-list-result': {
        const payload = msg.payload as FilesListResult;
        const pending = this.pendingLists.get(payload.requestId);
        if (!pending) return;
        this.pendingLists.delete(payload.requestId);
        const { requestId: _ignored, ...rest } = payload;
        pending.resolve(rest);
        return;
      }
      case 'files-download-begin': {
        const payload = msg.payload as FilesDownloadBegin;
        const active = this.transfers.get(payload.transferId);
        if (!active) return;
        // Update the state with the agent-declared size and chunk count so
        // onChunkReceived validation uses the correct expected lengths.
        active.state.totalChunks = payload.totalChunks;
        active.state.size = payload.size;
        active.declaredSize = payload.size;
        return;
      }
      case 'files-download-chunk': {
        const payload = msg.payload as {
          transferId: string;
          chunkIndex: number;
          data: string;
        };
        const active = this.transfers.get(payload.transferId);
        if (!active) return;
        const bytes = base64ToBytes(payload.data);
        if (!active.state.onChunkReceived(payload.chunkIndex, bytes.byteLength))
          return;
        active.buffer.push(bytes);
        active.receivedBytes += bytes.byteLength;
        this.sendJson('files-download-ack', {
          transferId: payload.transferId,
          nextChunkIndex: active.state.receivedCount,
        } satisfies FilesAckMessage);
        active.onProgress?.({
          transferId: payload.transferId,
          direction: 'download',
          bytesTransferred: active.receivedBytes,
          totalBytes: active.declaredSize,
          chunkIndex: payload.chunkIndex,
        });
        return;
      }
      case 'files-download-end': {
        const payload = msg.payload as FilesDownloadEnd;
        const active = this.transfers.get(payload.transferId);
        if (!active) return;
        this.transfers.delete(payload.transferId);
        const joined = new Uint8Array(active.receivedBytes);
        let offset = 0;
        for (const part of active.buffer) {
          joined.set(part, offset);
          offset += part.byteLength;
        }
        active.state.succeed(joined);
        return;
      }
      case 'files-upload-ack': {
        const payload = msg.payload as FilesAckMessage;
        const active = this.transfers.get(payload.transferId);
        if (!active) return;
        active.state.onAck(payload.nextChunkIndex);
        if (active.state.failure) return;
        active.state.pump();
        if (
          active.state.sentCount === active.state.totalChunks &&
          !active.ended
        ) {
          active.ended = true;
          this.sendJson('files-upload-end', {
            transferId: payload.transferId,
          } satisfies FilesUploadEndRequest);
        }
        return;
      }
      case 'files-upload-complete': {
        const payload = msg.payload as FilesUploadComplete;
        const active = this.transfers.get(payload.transferId);
        if (!active) return;
        this.transfers.delete(payload.transferId);
        active.state.succeed();
        return;
      }
      case 'files-error': {
        const payload = msg.payload as FilesErrorMessage;
        const error = new FilesError(
          payload.code,
          payload.message,
          payload.transferId,
        );
        if (payload.transferId && this.transfers.has(payload.transferId)) {
          const active = this.transfers.get(payload.transferId)!;
          this.transfers.delete(payload.transferId);
          active.state.fail(error);
          return;
        }
        if (payload.requestId && this.pendingLists.has(payload.requestId)) {
          const pending = this.pendingLists.get(payload.requestId)!;
          this.pendingLists.delete(payload.requestId);
          pending.reject(error);
          return;
        }
        for (const listener of [...this.errorListeners]) {
          listener(payload.code, payload.message);
        }
        return;
      }
      default:
        return;
    }
  }
}

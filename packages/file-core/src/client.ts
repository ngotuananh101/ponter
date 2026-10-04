import type { DataChannelManager } from '@ponter/webrtc-core';
import type {
  FilesAckMessage,
  FilesActionResult,
  FilesDeleteRequest,
  FilesDownloadBegin,
  FilesDownloadEnd,
  FilesDownloadRequest,
  FilesErrorMessage,
  FilesListRequest,
  FilesListResult,
  FilesMkdirRequest,
  FilesPauseAckMessage,
  FilesPauseMessage,
  FilesRenameRequest,
  FilesResumeAckMessage,
  FilesResumeRequest,
  FilesUploadBeginRequest,
  FilesUploadComplete,
  FilesUploadEndRequest,
  TransferDirection,
} from '@ponter/shared';
import {
  BINARY_TYPE_DOWNLOAD_CHUNK,
  BINARY_TYPE_UPLOAD_CHUNK,
} from '@ponter/shared';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_WINDOW_SIZE,
  FILE_CHUNK_BYTES,
  TransferState,
  totalChunksFor,
} from './transfer';
import { packBinaryChunk, unpackBinaryChunk } from './binary';
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
  /** Sliding-window size; default 64 (ADR-37). Test seam. */
  windowSize?: number;
  /** Idle timeout per transfer; default 30_000 ms (ADR-34). Test seam. */
  idleTimeoutMs?: number;
}

interface PendingList {
  resolve: (result: FileListResult) => void;
  reject: (error: FilesError) => void;
}

interface PendingAction {
  resolve: () => void;
  reject: (error: FilesError) => void;
}

function isFilesErrorCode(code: string): code is FileClientErrorCode {
  return [
    'PATH_OUTSIDE_ROOT',
    'INVALID_PATH',
    'NOT_FOUND',
    'NOT_A_FILE',
    'NOT_A_DIRECTORY',
    'FILE_EXISTS',
    'FILE_TOO_LARGE',
    'TRANSFER_BUSY',
    'TRANSFER_UNKNOWN',
    'TRANSFER_TIMEOUT',
    'IO_ERROR',
    'BAD_FRAME',
    'RESUME_INVALID',
    'DIR_NOT_EMPTY',
    'PERMISSION_DENIED',
    'QUEUE_FULL',
  ].includes(code);
}

interface ActiveTransfer {
  state: TransferState;
  onProgress?: (progress: TransferProgress) => void;
  buffer: Uint8Array[];
  receivedBytes: number;
  declaredSize: number;
  /** True once files-upload-end has been sent (acks can still arrive after the last chunk). */
  ended?: boolean;
  /** Tracked at download()/upload() time for resume (FilesResumeRequest). */
  path: string;
  /** Tracked at download()/upload() time for resume (FilesResumeRequest). */
  direction: TransferDirection;
  /** Chunk-forwarding callback for streaming downloads (spec AC#3). */
  onChunk?: (chunk: Uint8Array) => void;
}

function mintId(): string {
  return crypto.randomUUID();
}

export class FileClient {
  private readonly pendingLists = new Map<string, PendingList>();
  private readonly pendingActions = new Map<string, PendingAction>();
  private readonly transfers = new Map<string, ActiveTransfer>();
  private readonly pendingPauses = new Map<
    string,
    { resolve: () => void; reject: (e: FilesError) => void }
  >();
  private readonly pendingResumes = new Map<
    string,
    { resolve: () => void; reject: (e: FilesError) => void }
  >();
  private readonly errorListeners: Array<
    (code: FileClientErrorCode, message: string) => void
  > = [];
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeRaw: () => void;
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
    // ADR-36 (GAP-B): binary download chunks arrive as ArrayBuffer frames on
    // the raw seam; string data keeps the JSON control path.
    this.unsubscribeRaw = this.dataChannelManager.onRawMessage(
      'files',
      (data) => this.handleRawMessage(data),
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

  /**
   * Create a directory `name` inside `dir`. Resolves when the agent replies
   * with a matching `files-action-result`; rejects with a FilesError mapped
   * from the result (or `BAD_FRAME` for an unknown error code).
   */
  mkdir(dir: string, name: string): Promise<void> {
    this.assertLive();
    const requestId = mintId();
    return new Promise<void>((resolve, reject) => {
      this.pendingActions.set(requestId, { resolve, reject });
      const payload: FilesMkdirRequest = { requestId, dir, name };
      this.sendJson('files-mkdir', payload);
    });
  }

  /**
   * Delete `path` (recursively when `recursive`). Resolves on the agent's
   * matching `files-action-result`.
   */
  delete(path: string, recursive: boolean = false): Promise<void> {
    this.assertLive();
    const requestId = mintId();
    return new Promise<void>((resolve, reject) => {
      this.pendingActions.set(requestId, { resolve, reject });
      const payload: FilesDeleteRequest = { requestId, path, recursive };
      this.sendJson('files-delete', payload);
    });
  }

  /**
   * Rename `oldPath` to `newPath`. Resolves on the agent's matching
   * `files-action-result`.
   */
  rename(oldPath: string, newPath: string): Promise<void> {
    this.assertLive();
    const requestId = mintId();
    return new Promise<void>((resolve, reject) => {
      this.pendingActions.set(requestId, { resolve, reject });
      const payload: FilesRenameRequest = { requestId, oldPath, newPath };
      this.sendJson('files-rename', payload);
    });
  }

  /**
   * Download a file; `onProgress` fires per accepted chunk.
   *
   * When `onChunk` is provided, each decoded chunk is forwarded immediately and
   * NOT retained in memory (spec AC#3: <50 MB during a 500 MB transfer); `done`
   * resolves `void` in that mode. Without `onChunk`, behavior is unchanged
   * (assembled `Uint8Array`).
   */
  download(
    path: string,
    onProgress?: (progress: TransferProgress) => void,
    onChunk?: (chunk: Uint8Array) => void,
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
      path,
      direction: 'download',
      onChunk,
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
          // ADR-36 (GAP-B): upload chunks go out as binary frames, no base64.
          this.dataChannelManager.sendRaw(
            'files',
            packBinaryChunk(
              BINARY_TYPE_UPLOAD_CHUNK,
              transferId,
              chunkIndex,
              slice,
            ),
          );
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
      path: dirPath,
      direction: 'upload',
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

  /**
   * Upload a `File` object into `dirPath` under its own name (a single
   * component). Slices chunks via `file.slice()` so the full file is never
   * read into memory; chunks go out as ADR-36 binary frames (GAP-B).
   */
  uploadStream(
    dirPath: string,
    file: File,
    onProgress?: (progress: TransferProgress) => void,
  ): TransferHandle {
    this.assertLive();
    const transferId = mintId();
    const totalChunks = totalChunksFor(file.size);
    const state = new TransferState({
      transferId,
      direction: 'upload',
      totalChunks,
      size: file.size,
      windowSize: this.windowSize,
      idleTimeoutMs: this.idleTimeoutMs,
      send: (frame) => {
        if (frame.type === 'files-upload-chunk') {
          const chunkIndex =
            (frame.chunkIndex as number | undefined) ??
            ((frame.payload as Record<string, unknown> | undefined)
              ?.chunkIndex as number);
          // Slice from the File (never reads the whole file) then send raw.
          const start = chunkIndex * FILE_CHUNK_BYTES;
          const end = Math.min(start + FILE_CHUNK_BYTES, file.size);
          void file
            .slice(start, end)
            .arrayBuffer()
            .then((buf) => {
              this.dataChannelManager.sendRaw(
                'files',
                packBinaryChunk(
                  BINARY_TYPE_UPLOAD_CHUNK,
                  transferId,
                  chunkIndex,
                  new Uint8Array(buf),
                ),
              );
            });
          onProgress?.({
            transferId,
            direction: 'upload',
            bytesTransferred: Math.min(
              (chunkIndex + 1) * FILE_CHUNK_BYTES,
              file.size,
            ),
            totalBytes: file.size,
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
      declaredSize: file.size,
      path: dirPath,
      direction: 'upload',
    };
    this.transfers.set(transferId, active);
    state.armIdleTimer();

    const begin: FilesUploadBeginRequest = {
      transferId,
      path: dirPath,
      name: file.name,
      size: file.size,
    };
    this.sendJson('files-upload-begin', begin);
    return {
      transferId,
      direction: 'upload',
      done: state.settled as Promise<Uint8Array | void>,
      cancel: () => state.cancel(),
    };
  }

  /**
   * Pause a tracked transfer. Sends `files-pause`; resolves on the matching
   * `files-pause-ack`. The transfer's state must not pump while paused and its
   * idle timer must be cleared (a paused transfer must NOT hit TRANSFER_TIMEOUT).
   * Rejects with `FilesError('TRANSFER_UNKNOWN')` if the transfer is not tracked.
   */
  pauseTransfer(
    transferId: string,
    direction: 'download' | 'upload',
  ): Promise<void> {
    this.assertLive();
    const active = this.transfers.get(transferId);
    if (!active) {
      return Promise.reject(
        new FilesError('TRANSFER_UNKNOWN', 'transfer not tracked', transferId),
      );
    }
    // A paused transfer must not pump and must not hit the idle timeout.
    active.state.pause();
    return new Promise<void>((resolve, reject) => {
      this.pendingPauses.set(transferId, { resolve, reject });
      this.sendJson('files-pause', {
        transferId,
        direction,
      } satisfies FilesPauseMessage);
    });
  }

  /**
   * Resume a tracked transfer. Looks up the transfer's `direction` and `path`
   * (recorded at download()/upload() time), sends `files-resume`; resolves on
   * `files-resume-ack` with `approved: true`, rejects with
   * `FilesError('RESUME_INVALID')` when `approved: false`.
   */
  resumeTransfer(transferId: string, fromChunkIndex: number): Promise<void> {
    this.assertLive();
    const active = this.transfers.get(transferId);
    if (!active) {
      return Promise.reject(
        new FilesError('RESUME_INVALID', 'transfer not tracked', transferId),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingResumes.set(transferId, { resolve, reject });
      this.sendJson('files-resume', {
        transferId,
        path: active.path,
        direction: active.direction,
        fromChunkIndex,
      } satisfies FilesResumeRequest);
    });
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
    this.unsubscribeRaw();
    for (const [, transfer] of this.transfers) {
      transfer.state.dispose('CANCELLED');
    }
    this.transfers.clear();
    for (const [, pending] of this.pendingLists) {
      pending.reject(new FilesError('CANCELLED', 'client disposed'));
    }
    this.pendingLists.clear();
    for (const [, pending] of this.pendingActions) {
      pending.reject(new FilesError('CANCELLED', 'client disposed'));
    }
    this.pendingActions.clear();
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
      case 'files-action-result': {
        const payload = msg.payload as FilesActionResult;
        const pending = this.pendingActions.get(payload.requestId);
        if (!pending) return;
        this.pendingActions.delete(payload.requestId);
        if (payload.success) {
          pending.resolve();
          return;
        }
        const errMsg = payload.error ?? 'file operation failed';
        const code =
          payload.error && isFilesErrorCode(payload.error)
            ? payload.error
            : ('BAD_FRAME' as FileClientErrorCode);
        pending.reject(new FilesError(code, errMsg));
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
      case 'files-download-end': {
        const payload = msg.payload as FilesDownloadEnd;
        const active = this.transfers.get(payload.transferId);
        if (!active) return;
        this.transfers.delete(payload.transferId);
        if (active.onChunk) {
          // Streaming mode: chunks were forwarded via onChunk, not buffered.
          active.state.succeed();
          return;
        }
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
        if (payload.requestId && this.pendingActions.has(payload.requestId)) {
          const pending = this.pendingActions.get(payload.requestId)!;
          this.pendingActions.delete(payload.requestId);
          pending.reject(error);
          return;
        }
        for (const listener of [...this.errorListeners]) {
          listener(payload.code, payload.message);
        }
        return;
      }
      case 'files-pause-ack': {
        const payload = msg.payload as FilesPauseAckMessage;
        const pending = this.pendingPauses.get(payload.transferId);
        if (!pending) return;
        this.pendingPauses.delete(payload.transferId);
        pending.resolve();
        return;
      }
      case 'files-resume-ack': {
        const payload = msg.payload as FilesResumeAckMessage;
        const pending = this.pendingResumes.get(payload.transferId);
        if (!pending) return;
        this.pendingResumes.delete(payload.transferId);
        if (payload.approved) {
          // Resume the local transfer state: re-arm idle timer and refill window.
          const active = this.transfers.get(payload.transferId);
          if (active) active.state.resume();
          pending.resolve();
        } else {
          pending.reject(
            new FilesError(
              'RESUME_INVALID',
              payload.reason ?? 'resume refused',
              payload.transferId,
            ),
          );
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * ADR-36 (GAP-B): binary download chunks arrive as `ArrayBuffer` on the raw
   * seam. They are unpacked (no base64) and fed to the same receive path.
   */
  private handleRawMessage(data: string | ArrayBuffer): void {
    if (typeof data === 'string') return;
    let frame;
    try {
      frame = unpackBinaryChunk(new Uint8Array(data));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const listener of [...this.errorListeners]) {
        listener('BAD_FRAME', message);
      }
      return;
    }
    if (frame.type !== BINARY_TYPE_DOWNLOAD_CHUNK) return;
    const active = this.transfers.get(frame.transferId);
    if (!active) return;
    if (!active.state.onChunkReceived(frame.chunkIndex, frame.data.byteLength))
      return;
    active.receivedBytes += frame.data.byteLength;
    // Streaming mode (spec AC#3): forward the chunk immediately, do NOT retain
    // in memory. Without onChunk, buffer as before.
    if (active.onChunk) {
      active.onChunk(frame.data);
    } else {
      active.buffer.push(frame.data);
    }
    this.sendJson('files-download-ack', {
      transferId: frame.transferId,
      nextChunkIndex: active.state.receivedCount,
    } satisfies FilesAckMessage);
    active.onProgress?.({
      transferId: frame.transferId,
      direction: 'download',
      bytesTransferred: active.receivedBytes,
      totalBytes: active.declaredSize,
      chunkIndex: frame.chunkIndex,
    });
  }
}

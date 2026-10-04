import { FilesError, type FileClientErrorCode } from './errors';

/** Raw bytes per chunk (spec §2.5): 32 KiB → 43 692 base64 chars < 64 KiB. */
export const FILE_CHUNK_BYTES = 32768;

/** Sliding-window size in chunks (ADR-34). */
export const DEFAULT_WINDOW_SIZE = 16;

/** Idle timeout per transfer (ADR-34). */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** ceil(size / FILE_CHUNK_BYTES); 0 for an empty file (spec §2.5). */
export function totalChunksFor(size: number): number {
  return Math.ceil(size / FILE_CHUNK_BYTES);
}

/**
 * The byte length chunk `chunkIndex` must decode to (spec §2.4): every chunk
 * except the last is exactly FILE_CHUNK_BYTES; the last is the remainder.
 */
export function expectedChunkBytes(
  totalChunks: number,
  size: number,
  chunkIndex: number,
): number {
  if (chunkIndex < totalChunks - 1) return FILE_CHUNK_BYTES;
  return size - (totalChunks - 1) * FILE_CHUNK_BYTES;
}

export interface TransferStateOptions {
  transferId: string;
  direction: 'upload' | 'download';
  /** For an upload: derived from the local byte length. For a download: from files-download-begin. */
  totalChunks: number;
  /** Declared/known byte size — the single source of truth for chunk lengths. */
  size: number;
  windowSize: number;
  idleTimeoutMs: number;
  /** Emit one wire frame; fields are type-specific and carried flat (spec §2.4). */
  send: (frame: { type: string; [key: string]: unknown }) => void;
}

/**
 * The window/ack/timer state machine shared by both directions (spec §5.2.5).
 *
 * The sender may send while `sentCount - ackedCount < windowSize` and
 * `sentCount < totalChunks`. Acks are cumulative counts of contiguous chunks;
 * duplicate/regressive acks are ignored, an ack beyond `sentCount` is BAD_FRAME.
 * On the receiving side, `onChunkReceived` validates contiguity and the
 * chunk-length rule, and answers with a cumulative ack via the client.
 */
export class TransferState {
  readonly transferId: string;
  readonly direction: 'upload' | 'download';
  totalChunks: number;
  size: number;

  sentCount = 0;
  ackedCount = 0;
  receivedCount = 0;
  failure: FilesError | null = null;

  private readonly windowSize: number;
  private readonly idleTimeoutMs: number;
  private readonly send: TransferStateOptions['send'];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private settlePromise: Promise<Uint8Array | void>;
  private settleResolve!: (value: Uint8Array | void) => void;
  private settleReject!: (error: FilesError) => void;
  private cancelSent = false;

  constructor(options: TransferStateOptions) {
    this.transferId = options.transferId;
    this.direction = options.direction;
    this.totalChunks = options.totalChunks;
    this.size = options.size;
    this.windowSize = options.windowSize;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.send = options.send;
    this.settlePromise = new Promise((resolve, reject) => {
      this.settleResolve = resolve;
      this.settleReject = reject;
    });
  }

  get settled(): Promise<Uint8Array | void> {
    return this.settlePromise;
  }

  get windowOpen(): boolean {
    return this.sentCount - this.ackedCount < this.windowSize;
  }

  /** Start (or restart) the idle timer; every chunk/ack resets it. */
  armIdleTimer(): void {
    if (this.failure) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.fail(
        new FilesError(
          'TRANSFER_TIMEOUT',
          'transfer idle timeout',
          this.transferId,
        ),
      );
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** The send side: emit chunks while the window is open. */
  pump(): void {
    if (this.direction !== 'upload') {
      throw new Error(
        'TransferState.pump() is upload-only; download is receive-side (spec §5.2.5)',
      );
    }
    if (this.failure) return;
    while (this.windowOpen && this.sentCount < this.totalChunks) {
      const chunkIndex = this.sentCount;
      this.send({
        type:
          this.direction === 'upload'
            ? 'files-upload-chunk'
            : 'files-download-chunk',
        chunkIndex,
      });
      this.sentCount += 1;
    }
  }

  /** Validate one cumulative ack; ignored when duplicate/regressive. */
  onAck(nextChunkIndex: number): void {
    if (this.failure) return;
    if (nextChunkIndex > this.sentCount) {
      this.fail(
        new FilesError('BAD_FRAME', 'ack beyond sent chunks', this.transferId),
      );
      return;
    }
    if (nextChunkIndex <= this.ackedCount) return;
    this.ackedCount = nextChunkIndex;
    this.armIdleTimer();
    // A cumulative ack opens window space — refill it.
    this.pump();
  }

  /** Validate one received chunk; returns false when it was rejected. */
  onChunkReceived(chunkIndex: number, decodedLength: number): boolean {
    if (this.failure) return false;
    if (chunkIndex !== this.receivedCount) {
      this.fail(new FilesError('BAD_FRAME', 'chunk gap', this.transferId));
      return false;
    }
    if (
      decodedLength !==
      expectedChunkBytes(this.totalChunks, this.size, chunkIndex)
    ) {
      this.fail(
        new FilesError('BAD_FRAME', 'chunk length mismatch', this.transferId),
      );
      return false;
    }
    this.receivedCount += 1;
    this.armIdleTimer();
    return true;
  }

  succeed(value?: Uint8Array): void {
    if (this.failure) return;
    this.clearIdleTimer();
    this.settleResolve(value);
  }

  fail(error: FilesError): void {
    if (this.failure) return;
    this.failure = error;
    this.clearIdleTimer();
    this.settleReject(error);
  }

  /** Idempotent: sends at most one files-cancel and rejects with CANCELLED. */
  cancel(): void {
    if (this.failure) return;
    if (!this.cancelSent) {
      this.cancelSent = true;
      this.send({ type: 'files-cancel', transferId: this.transferId });
    }
    this.fail(
      new FilesError('CANCELLED', 'transfer cancelled', this.transferId),
    );
  }

  /** Local teardown (dispose/disconnect): reject without a wire frame. */
  dispose(code: FileClientErrorCode = 'CANCELLED'): void {
    this.fail(new FilesError(code, 'transfer disposed', this.transferId));
  }
}

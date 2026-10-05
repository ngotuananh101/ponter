/**
 * `ServiceWorkerStreamWriter` streams file chunks to disk via a `MessagePort`
 * handed to the download service worker at init. Each `writeChunk` / `end` call
 * posts a typed message over the port; the SW's fetch handler feeds those
 * messages into a `ReadableStream` that the browser downloads natively.
 *
 * The writer is constructed over a real `MessagePort` (from a `MessageChannel`)
 * in production. Tests pass a mock port pair (see `test/pause-resume.test.ts`)
 * and can close the far end mid-transfer to verify Review Focus #4: a closed
 * port rejects subsequent writes, flips `isClosed`, and releases the near port
 * — no dangling channels, no unhandled rejection.
 */

export interface StreamWriterMeta {
  transferId: string;
  filename: string;
  size: number;
}

interface StreamWriterOptions {
  transferId: string;
  filename: string;
  size: number;
}

export class ServiceWorkerStreamWriter {
  private readonly port: MessagePort;
  private readonly meta: StreamWriterMeta;
  private released = false;
  private _isClosed = false;

  /**
   * Construct over a `MessagePort`. In production this comes from a
   * `MessageChannel`; tests pass a mock port pair.
   */
  constructor(port: MessagePort, options: StreamWriterOptions) {
    this.port = port;
    this.meta = options;
    // Listen for port-level errors so a broken far end is detected even
    // without an explicit write attempt (e.g. the SW navigated away).
    this.port.onmessageerror = () => {
      this._isClosed = true;
      this.release();
    };
    this.port.addEventListener('close', () => {
      this._isClosed = true;
      this.release();
    });
  }

  /**
   * Post a CHUNK message through the port. Resolves once the message is
   * queued; rejects if the port was closed (Review Focus #4).
   */
  writeChunk(chunk: Uint8Array): Promise<void> {
    if (this._isClosed || this.released) {
      return Promise.reject(
        new DOMException('port closed', 'InvalidStateError'),
      );
    }
    try {
      this.port.postMessage({
        type: 'CHUNK',
        transferId: this.meta.transferId,
        chunk,
      });
      return Promise.resolve();
    } catch {
      this._isClosed = true;
      this.release();
      return Promise.reject(
        new DOMException('port closed', 'InvalidStateError'),
      );
    }
  }

  /**
   * Post an END message and resolve when the port is released. Rejects if the
   * port closed before END could be delivered (Review Focus #4).
   */
  end(): Promise<void> {
    if (this._isClosed || this.released) {
      return Promise.reject(
        new DOMException('port closed', 'InvalidStateError'),
      );
    }
    try {
      this.port.postMessage({ type: 'END', transferId: this.meta.transferId });
      this.release();
      return Promise.resolve();
    } catch {
      this._isClosed = true;
      this.release();
      return Promise.reject(
        new DOMException('port closed', 'InvalidStateError'),
      );
    }
  }

  /** Abort the transfer: close the port and mark closed. Idempotent. */
  abort(_reason?: string): void {
    if (this.released) return;
    this._isClosed = true;
    this.release();
  }

  /** True once the port has been released / closed. */
  get isClosed(): boolean {
    return this._isClosed || this.released;
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    try {
      this.port.close();
    } catch {
      // Already closed; safe to ignore.
    }
  }
}

import type { PeerConnection } from '@ponter/webrtc-core';
import type { DesktopClientOptions, DesktopStream } from './types';

const DEFAULT_TRACK_TIMEOUT_MS = 20_000;

/**
 * The desktop twin of `TerminalClient`: DOM-free, unit-testable, and the same
 * object the E2E suite drives. It never creates a data channel and never
 * touches the DOM — it owns exactly one thing, the first remote video track.
 */
export class DesktopClient {
  private readonly trackTimeoutMs: number;
  private readonly stateListeners: Array<(state: string) => void> = [];
  private readonly errorListeners: Array<(message: string) => void> = [];
  private closed = false;
  private started = false;
  /** Rejects the in-flight `start()` when `close()` is called while waiting. */
  private pendingReject: ((error: Error) => void) | null = null;
  /** Unsubscribes from the peer's connection state. Lazily created. */
  private peerStateUnsubscribe: (() => void) | null = null;

  constructor(
    public readonly agentId: string,
    private readonly peer: PeerConnection,
    options?: DesktopClientOptions,
  ) {
    this.trackTimeoutMs = options?.trackTimeoutMs ?? DEFAULT_TRACK_TIMEOUT_MS;
  }

  /**
   * Run the offer/answer handshake and resolve with the first remote track.
   *
   * The track subscription is registered BEFORE `peer.start()`: a track can
   * arrive in the very first negotiation tick, and missing it would turn into
   * a full `trackTimeoutMs` wait for a stream that is already flowing.
   */
  async start(): Promise<DesktopStream> {
    if (this.closed) throw new Error('DesktopClient is closed');

    let resolveTrack!: (stream: DesktopStream) => void;
    let rejectTrack!: (error: Error) => void;
    const trackPromise = new Promise<DesktopStream>((resolve, reject) => {
      resolveTrack = resolve;
      rejectTrack = reject;
    });

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    // `close()` rejects through this hook rather than relying on the peer to
    // emit a state event: the mock peer does not, and a real `close()` should
    // not depend on event timing to fail the pending wait.
    this.pendingReject = (error) => settle(() => rejectTrack(error));

    const removeTrackHandler = this.peer.onRemoteTrack((track, streams) => {
      settle(() => resolveTrack({ track, streams }));
    });

    const removeStateHandler = this.onConnectionStateChange((state) => {
      if (state === 'failed' || state === 'closed') {
        settle(() =>
          rejectTrack(
            new Error(`the connection ${state} before a track arrived`),
          ),
        );
      }
    });

    const timeout = setTimeout(() => {
      settle(() =>
        rejectTrack(
          new Error(
            `timed out after ${this.trackTimeoutMs}ms waiting for a remote video track`,
          ),
        ),
      );
    }, this.trackTimeoutMs);

    // Every exit path clears the timeout and detaches the listeners; the
    // track listener is intentionally NOT removed on success so a future
    // `close()` is the only thing that ends delivery.
    const cleanup = (keepTrackHandler: boolean) => {
      clearTimeout(timeout);
      this.pendingReject = null;
      if (!keepTrackHandler) removeTrackHandler();
      removeStateHandler();
    };

    try {
      this.started = true;
      await this.peer.start();
    } catch (error) {
      cleanup(false);
      throw error instanceof Error ? error : new Error(String(error));
    }

    try {
      const stream = await trackPromise;
      cleanup(true);
      return stream;
    } catch (error) {
      cleanup(false);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  onConnectionStateChange(handler: (state: string) => void): () => void {
    // Lazily subscribe to the peer's connection state so handlers registered
    // before start() still receive state changes.
    if (this.peerStateUnsubscribe === null) {
      this.peerStateUnsubscribe = this.peer.onConnectionStateChange((state) =>
        this.forwardState(state),
      );
    }
    this.stateListeners.push(handler);
    return () => {
      const idx = this.stateListeners.indexOf(handler);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  private forwardState(state: string): void {
    for (const listener of [...this.stateListeners]) {
      listener(state);
    }
  }

  onError(handler: (message: string) => void): () => void {
    this.errorListeners.push(handler);
    return () => {
      const idx = this.errorListeners.indexOf(handler);
      if (idx >= 0) this.errorListeners.splice(idx, 1);
    };
  }

  /** Idempotent: closes the underlying peer exactly once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingReject) {
      const reject = this.pendingReject;
      this.pendingReject = null;
      reject(new Error('DesktopClient closed while waiting for a track'));
    }
    this.peerStateUnsubscribe?.();
    this.peerStateUnsubscribe = null;
    void this.peer.close();
  }
}

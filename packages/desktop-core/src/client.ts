import type { DesktopSourceInfo, DesktopStats } from '@ponter/shared';
import type { PeerConnection } from '@ponter/webrtc-core';
import type { DesktopClientOptions, DesktopStream } from './types';

const DEFAULT_TRACK_TIMEOUT_MS = 20_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;

/**
 * The desktop twin of `TerminalClient`: DOM-free, unit-testable, and the same
 * object the E2E suite drives. It never creates a data channel and never
 * touches the DOM — it owns exactly one thing, the first remote video track.
 */
export class DesktopClient {
  private readonly trackTimeoutMs: number;
  private readonly controlTimeoutMs: number;
  private readonly stateListeners: Array<(state: string) => void> = [];
  private readonly errorListeners: Array<(message: string) => void> = [];
  private readonly sourceListeners: Array<
    (sources: DesktopSourceInfo[]) => void
  > = [];
  private readonly statsListeners: Array<(stats: DesktopStats) => void> = [];
  private closed = false;
  private started = false;
  /**
   * Last control frame per kind, cached even with no listener attached. The
   * agent pushes `desktop-sources` once the control channel opens, which can
   * beat the store's listener registration; without a cache that frame would be
   * lost and the picker would stay empty. `undefined` means "no frame yet".
   */
  private lastSources: DesktopSourceInfo[] | undefined;
  private lastStats: DesktopStats | undefined;
  /** Rejects the in-flight `start()` when `close()` is called while waiting. */
  private pendingReject: ((error: Error) => void) | null = null;
  /** Unsubscribes from the peer's connection state. Lazily created. */
  private peerStateUnsubscribe: (() => void) | null = null;
  /** Unsubscribes from the control channel's typed messages. Set after start(). */
  private controlUnsubscribe: (() => void) | null = null;

  constructor(
    public readonly agentId: string,
    private readonly peer: PeerConnection,
    options?: DesktopClientOptions,
  ) {
    this.trackTimeoutMs = options?.trackTimeoutMs ?? DEFAULT_TRACK_TIMEOUT_MS;
    this.controlTimeoutMs =
      options?.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
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
      this.subscribeControl();
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
    this.peerStateUnsubscribe ??= this.peer.onConnectionStateChange((state) =>
      this.forwardState(state),
    );
    this.stateListeners.push(handler);
    return () => {
      const idx = this.stateListeners.indexOf(handler);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  private forwardState(state: string): void {
    for (const listener of this.stateListeners.slice()) {
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

  /**
   * Subscribe to the control channel once the media track has resolved.
   *
   * The agent sends `desktop-sources` when the control channel opens, which is
   * after the answer, so the listener is registered here rather than in the
   * constructor. It must still be in place before any frame can arrive (the
   * manager does not replay). The wait below is best-effort: the channel
   * opening late must not fail the stream (media already flows), so a missing
   * channel is logged, not thrown.
   */
  private subscribeControl(): void {
    this.controlUnsubscribe = this.peer.dataChannels.onMessage<unknown>(
      'control',
      (msg) => this.dispatchControl(msg),
    );
    // Fire-and-forget liveness check: a control channel that never opens leaves
    // the picker empty, which is worth one warning — but it must never reject
    // `start()`. `controlTimeoutMs` bounds the wait; the `closed` guard keeps a
    // normal teardown from logging a spurious warning.
    void this.peer
      .waitForChannel('control', this.controlTimeoutMs)
      .catch((error: unknown) => {
        if (this.closed) return;
        console.warn(
          `[desktop] control channel did not open: ${String(error)}`,
        );
      });
  }

  private dispatchControl(msg: { type?: string; payload?: unknown }): void {
    switch (msg.type) {
      case 'desktop-sources': {
        const payload = msg.payload as
          { sources?: DesktopSourceInfo[] } | undefined;
        // Cache before fan-out so a listener registered later still sees it,
        // and so the cache updates even with zero listeners attached.
        this.lastSources = payload?.sources ?? [];
        for (const listener of this.sourceListeners.slice()) {
          listener(this.lastSources);
        }
        break;
      }
      case 'desktop-stats': {
        const stats = this.parseStats(msg.payload);
        if (!stats) break;
        this.lastStats = stats;
        for (const listener of this.statsListeners.slice()) {
          listener(stats);
        }
        break;
      }
      default:
        // Forward-compatible: an unknown control type is ignored, never an error.
        break;
    }
  }

  /**
   * Accept only a well-formed stats frame. A partial payload (e.g. a frame from
   * an older agent) would otherwise flow into the UI and render `NaN×NaN`.
   */
  private parseStats(payload: unknown): DesktopStats | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const p = payload as Partial<DesktopStats>;
    if (
      !Number.isFinite(p.width) ||
      !Number.isFinite(p.height) ||
      !Number.isFinite(p.fps) ||
      !Number.isFinite(p.targetBitrateBps)
    ) {
      return null;
    }
    return p as DesktopStats;
  }

  /** Capture-source enumeration pushed by the agent (once, after connect). */
  onSources(handler: (sources: DesktopSourceInfo[]) => void): () => void {
    this.sourceListeners.push(handler);
    // Register first, then replay: run-to-completion means no frame can slip
    // between the two, so a cached frame is delivered exactly once.
    if (this.lastSources !== undefined) handler(this.lastSources);
    return () => {
      const idx = this.sourceListeners.indexOf(handler);
      if (idx >= 0) this.sourceListeners.splice(idx, 1);
    };
  }

  /** Telemetry (resolution/fps/effective bitrate), best-effort. */
  onStats(handler: (stats: DesktopStats) => void): () => void {
    this.statsListeners.push(handler);
    if (this.lastStats !== undefined) handler(this.lastStats);
    return () => {
      const idx = this.statsListeners.indexOf(handler);
      if (idx >= 0) this.statsListeners.splice(idx, 1);
    };
  }

  /**
   * Ask the agent to switch to `sourceId`.
   *
   * `sendJson` throws when the `'control'` label is not registered
   * (`data-channel.ts:75-77`), and `RTCDataChannel.send()` throws
   * `InvalidStateError` when the channel is not `open`. The offerer pre-creates
   * the channel in its constructor, so `hasChannel` is true from the start even
   * while it is still `connecting` — hence the guard tests `readyState`, not
   * mere registration. A click before the channel opens warns and returns
   * rather than throwing into the UI handler.
   */
  selectSource(sourceId: string): void {
    this.sendControl('desktop-select', { sourceId });
  }

  /** Set the target bitrate. Same guard as `selectSource`. */
  setBitrate(bitrateBps: number): void {
    this.sendControl('desktop-bitrate', { bitrateBps });
  }

  private sendControl(type: string, payload: unknown): void {
    if (this.peer.dataChannels.getChannel('control')?.readyState !== 'open') {
      console.warn(`[desktop] control channel not open; dropping ${type}`);
      return;
    }
    this.peer.dataChannels.sendJson('control', type, payload);
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
    this.controlUnsubscribe?.();
    this.controlUnsubscribe = null;
    this.peerStateUnsubscribe?.();
    this.peerStateUnsubscribe = null;
    // Release every handler the caller may still hold. The `off` closures it
    // keeps would otherwise splice a closed client's arrays on a later call.
    this.stateListeners.length = 0;
    this.errorListeners.length = 0;
    this.sourceListeners.length = 0;
    this.statsListeners.length = 0;
    void this.peer.close();
  }
}

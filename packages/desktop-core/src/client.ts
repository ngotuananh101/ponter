import type {
  DesktopInput,
  DesktopSourcesPayload,
  DesktopStats,
  TerminalE2eeAck,
} from '@ponter/shared';
import type { PeerConnection } from '@ponter/webrtc-core';
import type {
  DesktopClientOptions,
  DesktopE2eeDriver,
  DesktopStream,
} from './types';

const DEFAULT_TRACK_TIMEOUT_MS = 20_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;
const DEFAULT_INPUT_RATE_LIMIT_HZ = 60;

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCodePoint(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * The desktop twin of `TerminalClient`: DOM-free, unit-testable, and the same
 * object the E2E suite drives. It never creates a data channel and never
 * touches the DOM — it owns exactly one thing, the first remote video track.
 */
export class DesktopClient {
  private readonly trackTimeoutMs: number;
  private readonly controlTimeoutMs: number;
  private readonly inputRateLimitHz: number;
  private readonly playoutDelayMs: number | null;
  private readonly stateListeners: Array<(state: string) => void> = [];
  private readonly errorListeners: Array<(message: string) => void> = [];
  private readonly sourceListeners: Array<
    (payload: DesktopSourcesPayload) => void
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
  private lastSources: DesktopSourcesPayload | undefined;
  private lastStats: DesktopStats | undefined;
  /** The newest coalesced `pointer-move` awaiting the next allowed send. */
  private pendingMove: DesktopInput | null = null;
  /** Whether a flush is already scheduled for the current rate window. */
  private moveFlushScheduled = false;
  /** Rejects the in-flight `start()` when `close()` is called while waiting. */
  private pendingReject: ((error: Error) => void) | null = null;
  /** Unsubscribes from the peer's connection state. Lazily created. */
  private peerStateUnsubscribe: (() => void) | null = null;
  /** Unsubscribes from the control channel's typed messages. Set after start(). */
  private controlUnsubscribe: (() => void) | null = null;
  /** WS1 E2EE driver; absent → plaintext input path stays byte-identical. */
  private readonly e2ee: DesktopE2eeDriver | undefined;
  /** Idempotency guard for the desktop-e2ee-hello (mirrors `negotiatedTerminals`). */
  private e2eeNegotiated = false;
  /** Ordered chain for encrypted sends — preserves frame order, isolates failures. */
  private sendChain: Promise<void> = Promise.resolve();

  constructor(
    public readonly agentId: string,
    private readonly peer: PeerConnection,
    options?: DesktopClientOptions,
    e2ee?: DesktopE2eeDriver,
  ) {
    this.e2ee = e2ee;
    this.trackTimeoutMs = options?.trackTimeoutMs ?? DEFAULT_TRACK_TIMEOUT_MS;
    this.controlTimeoutMs =
      options?.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    this.inputRateLimitHz =
      options?.inputRateLimitHz ?? DEFAULT_INPUT_RATE_LIMIT_HZ;
    this.playoutDelayMs =
      options?.playoutDelayMs !== undefined ? options.playoutDelayMs : 100;
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
      this.applyPlayoutTuning();
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
      .then(() => {
        // T6-A: drive the WS1 hello from the client, once the control channel
        // is confirmed open — mirroring TerminalClient's createSession hello.
        if (!this.closed) this.negotiateE2ee();
      })
      .catch((error: unknown) => {
        if (this.closed) return;
        console.warn(
          `[desktop] control channel did not open: ${String(error)}`,
        );
      });
  }

  /**
   * T6-A: send the `desktop-e2ee-hello` once the control channel is open.
   *
   * Idempotent: guarded by `e2eeNegotiated` so a late re-subscribe or a
   * retried `waitForChannel` cannot emit a duplicate hello (mirrors
   * `negotiatedTerminals` in TerminalClient). No-op when there is no driver
   * or when the session key is already active.
   */
  private negotiateE2ee(): void {
    if (!this.e2ee || this.e2eeNegotiated || this.e2ee.isActive()) return;
    this.e2eeNegotiated = true;
    const sessionId = this.peer.options.sessionId;
    this.sendChain = this.sendChain
      .then(async () => {
        const hello = await this.e2ee!.buildHello(sessionId);
        this.peer.dataChannels.sendJson('control', 'desktop-e2ee-hello', hello);
      })
      .catch((err: unknown) => {
        for (const listener of [...this.errorListeners]) {
          listener(
            `desktop-e2ee-hello send chain failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
  }

  private dispatchControl(msg: { type?: string; payload?: unknown }): void {
    switch (msg.type) {
      case 'desktop-sources': {
        const payload = msg.payload as
          Partial<DesktopSourcesPayload> | undefined;
        // Normalize to the Week 9 payload shape: a Week 8 agent that omits
        // `inputEnabled` yields `false` (the gate is closed), and a pre-6a
        // agent that omits `peerVerified` yields `false` (unverified) —
        // never `undefined`, so the UI can never render a false claim.
        const next: DesktopSourcesPayload = {
          sources: payload?.sources ?? [],
          inputEnabled: payload?.inputEnabled === true,
          peerVerified: payload?.peerVerified === true,
        };
        // Cache before fan-out so a listener registered later still sees it,
        // and so the cache updates even with zero listeners attached.
        this.lastSources = next;
        for (const listener of this.sourceListeners.slice()) {
          listener(next);
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
      case 'desktop-e2ee-ack': {
        // T6-A: install the session key derived from the agent's ack so a
        // subsequent `desktop-input` is encrypted, not plaintext.
        if (!this.e2ee) break;
        this.receiveE2eeAck(msg.payload as TerminalE2eeAck).catch(
          (err: unknown) => {
            for (const listener of [...this.errorListeners]) {
              listener(
                `desktop-e2ee-ack failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          },
        );
        break;
      }
      default:
        // Forward-compatible: an unknown control type is ignored, never an error.
        break;
    }
  }

  /**
   * Apply the agent's ack: the driver derives the session key and flips to active.
   * Fail-closed — a bad ack leaves `isActive()` false and input stays plaintext.
   */
  private async receiveE2eeAck(ack: TerminalE2eeAck): Promise<void> {
    await this.e2ee!.handleAck(ack);
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

  /**
   * Capture-source enumeration + input gate, pushed by the agent (once, after
   * connect). Week 9 widens the yield from `DesktopSourceInfo[]` to the
   * `DesktopSourcesPayload` that also carries `inputEnabled` (spec §5.3).
   */
  onSources(handler: (payload: DesktopSourcesPayload) => void): () => void {
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

  /**
   * Forward one input event (spec §5.3). Discrete events (`pointer-button`,
   * `wheel`, `key`, `text`) go straight through — dropping a click would be a
   * correctness bug. `pointer-move` is coalesced to `inputRateLimitHz`: the
   * first move in a window is forwarded immediately (leading edge, so a single
   * move is never swallowed) and locks the window for 1/inputRateLimitHz s.
   * Intermediate moves update `pendingMove`, and each window flush delivers the
   * newest position and re-arms until the pointer settles. No-op + warn when
   * the control channel is not open, mirroring `sendControl`; a DOM event
   * handler must never throw into the UI.
   */
  sendInput(event: DesktopInput): void {
    if (event.kind !== 'pointer-move') {
      this.sendControl('desktop-input', event);
      return;
    }
    this.pendingMove = event;
    if (this.moveFlushScheduled) return;
    this.flushPendingMove();
  }

  private flushPendingMove(): void {
    this.moveFlushScheduled = false;
    const move = this.pendingMove;
    this.pendingMove = null;
    if (!move) return;
    this.sendControl('desktop-input', move);
    this.moveFlushScheduled = true;
    const delayMs = Math.max(0, Math.round(1000 / this.inputRateLimitHz));
    setTimeout(() => this.flushPendingMove(), delayMs);
  }

  private sendControl(type: string, payload: unknown): void {
    // The readyState guard is always first: a channel that is not `open` cannot
    // send, encrypted or otherwise. Tests assert this warning path is unchanged.
    if (this.peer.dataChannels.getChannel('control')?.readyState !== 'open') {
      console.warn(`[desktop] control channel not open; dropping ${type}`);
      return;
    }
    // T6-C: only `desktop-input` is encrypted, and only when the session key is
    // active (i.e. the ack has been processed). Non-input types and the dormant
    // case (`!isActive()`) stay byte-identical to today.
    if (this.e2ee && this.e2ee.isActive() && type === 'desktop-input') {
      const data = payload as DesktopInput;
      const json = JSON.stringify(data);
      const plaintext = new TextEncoder().encode(json);
      this.sendChain = this.sendChain
        .then(async () => {
          const framed = await this.e2ee!.encrypt(plaintext);
          this.peer.dataChannels.sendJson('control', type, {
            data: uint8ArrayToBase64(framed),
          });
        })
        .catch((err: unknown) => {
          for (const listener of [...this.errorListeners]) {
            listener(
              `desktop-input encrypt send chain failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
      return;
    }
    this.peer.dataChannels.sendJson('control', type, payload);
  }

  /**
   * Apply playout-delay tuning to the remote video receiver (Task 9).
   *
   * Called once `start()` resolves with the first track. Two browser seams
   * exist: Chrome exposes `jitterBufferTarget` (ms), Firefox exposes
   * `playoutDelayHint` (seconds). One or the other is written when present;
   * when the receiver is absent (werift agent / mock peer) this is a no-op.
   * `playoutDelayMs === null` disables tuning entirely.
   */
  private applyPlayoutTuning(): void {
    if (this.playoutDelayMs === null) return;
    const peerAny = this.peer as unknown as {
      peer?: { getVideoReceiver?: () => unknown };
    };
    const receiver = peerAny.peer?.getVideoReceiver?.() as
      Record<string, unknown> | undefined;
    if (!receiver) return;
    if ('jitterBufferTarget' in receiver) {
      receiver.jitterBufferTarget = Math.min(
        4000,
        Math.max(0, this.playoutDelayMs),
      );
    } else if ('playoutDelayHint' in receiver) {
      receiver.playoutDelayHint = Math.max(0, this.playoutDelayMs) / 1000;
    }
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
    // Drop a pending coalesced move so a closed client sends nothing.
    this.pendingMove = null;
    // Release every handler the caller may still hold. The `off` closures it
    // keeps would otherwise splice a closed client's arrays on a later call.
    this.stateListeners.length = 0;
    this.errorListeners.length = 0;
    this.sourceListeners.length = 0;
    this.statsListeners.length = 0;
    void this.peer.close();
  }
}

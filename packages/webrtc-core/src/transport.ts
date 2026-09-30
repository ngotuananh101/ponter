import type { SignalTransport } from './types';
import type { BrowserErrorCode, SignalMessage } from '@ponter/shared';

export interface RESTPollingTransportOptions {
  baseUrl: string;
  sessionId: string;
  token: string;
  fetch?: typeof fetch;
  /**
   * Called on a 401 to obtain a fresh access token, or `null` when the refresh
   * itself failed.
   *
   * The transport cannot refresh on its own: token storage and the refresh
   * endpoint live in the app, not in this package, so the caller injects the
   * capability. Without it a session outliving its access token hits a hard 401
   * with no recovery — the poll loop backs off to its cap and retries forever
   * while the user watches a tab that never opens.
   */
  onUnauthorized?: () => Promise<string | null>;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
}

interface RawPollItem {
  id: string;
  sessionId: string;
  type: 'offer' | 'answer' | 'ice-candidate';
  payload: unknown;
  createdAt?: string;
}

interface RawPollResponse {
  signals: RawPollItem[];
  cursor: string | null;
}

export class RESTPollingTransport implements SignalTransport {
  private readonly baseUrl: string;
  private readonly sessionId: string;
  private token: string;
  private readonly customFetch: typeof fetch;
  private readonly onUnauthorized?: () => Promise<string | null>;
  private readonly initialIntervalMs: number;
  private readonly maxIntervalMs: number;

  private currentIntervalMs: number;
  private cursor: string | null = null;
  private isClosed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * True while one `poll()` fetch is in flight.
   *
   * `send()` calls `reschedule(0)` so a reply is picked up promptly, but a
   * trickled ICE candidate completes a `send()` while the previous poll is
   * still awaiting its response. Without this guard the timer fires a second
   * `poll()` with the same cursor, both polls return the same DB row (signals
   * are never consumed on read), and the answer is delivered twice — the
   * offerer then calls `setRemoteDescription(answer)` on an already-stable
   * peer (`InvalidStateError: Called in wrong state: stable`). The flag makes
   * overlapping polls serialize: the redundant one reschedules and returns,
   * and the in-flight poll's own `finally` schedules the next round.
   */
  private pollInFlight = false;
  private readonly subscribers: Array<(msg: SignalMessage) => void> = [];

  constructor(options: RESTPollingTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.sessionId = options.sessionId;
    this.token = options.token;
    this.customFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.onUnauthorized = options.onUnauthorized;
    this.initialIntervalMs = options.initialIntervalMs ?? 200;
    this.maxIntervalMs = options.maxIntervalMs ?? 2000;
    this.currentIntervalMs = this.initialIntervalMs;
  }

  /**
   * Run `attempt`, and on a 401 refresh the token and run it exactly once more.
   *
   * One retry, never a loop: a refresh that cannot fix the problem (a revoked
   * token, a disabled account) would otherwise turn a hard 401 into a hot loop
   * hammering the server. A failed refresh rethrows the original 401 so the
   * caller sees the real failure rather than a synthesized one.
   */
  private async withTokenRefresh(
    attempt: (token: string) => Promise<Response>,
  ): Promise<Response> {
    const res = await attempt(this.token);
    if (res.status !== 401 || !this.onUnauthorized) {
      return res;
    }

    const fresh = await this.onUnauthorized();
    if (!fresh) {
      return res;
    }
    this.token = fresh;
    return attempt(fresh);
  }

  async send(msg: SignalMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error('Transport closed');
    }

    let endpoint = '';
    switch (msg.type) {
      case 'offer':
        endpoint = `${this.baseUrl}/api/signal/offer`;
        break;
      case 'answer':
        endpoint = `${this.baseUrl}/api/signal/answer`;
        break;
      case 'ice-candidate':
        endpoint = `${this.baseUrl}/api/signal/ice-candidate`;
        break;
    }

    const res = await this.withTokenRefresh((token) =>
      this.customFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        // The transport is session-scoped, so it stamps the session id onto the
        // wire payload. `PeerConnection` builds signals without one because the
        // spec's `PeerConnectionOptions` carries no sessionId; re-assigning an
        // existing key preserves its position, so payloads that already carry the
        // correct id serialize identically.
        body: JSON.stringify({ ...msg.data, sessionId: this.sessionId }),
      }),
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Failed to send signal ${msg.type}: HTTP ${res.status} ${text}`,
      );
    }

    // Reset backoff on activity so response signals are received promptly
    this.currentIntervalMs = this.initialIntervalMs;
    this.reschedule(0);
  }

  subscribe(handler: (msg: SignalMessage) => void): () => void {
    this.subscribers.push(handler);
    if (!this.timer && !this.isClosed) {
      this.reschedule(this.initialIntervalMs);
    }
    return () => {
      const idx = this.subscribers.indexOf(handler);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  close(): void {
    this.isClosed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.subscribers.length = 0;
  }

  private reschedule(delayMs: number): void {
    if (this.isClosed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (this.isClosed) return;
    if (this.pollInFlight) {
      // A redundant wake-up raced an in-flight poll (see `pollInFlight`): drop
      // it rather than fetching the same cursor twice. The in-flight poll's
      // `finally` schedules the next round, so no round is lost.
      return;
    }
    this.pollInFlight = true;

    try {
      const query = this.cursor
        ? `?after=${encodeURIComponent(this.cursor)}`
        : '';
      const url = `${this.baseUrl}/api/signal/poll/${encodeURIComponent(this.sessionId)}${query}`;

      const res = await this.withTokenRefresh((token) =>
        this.customFetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );

      if (!res.ok) {
        // Back off on error
        this.currentIntervalMs = Math.min(
          this.currentIntervalMs * 1.5,
          this.maxIntervalMs,
        );
        this.reschedule(this.currentIntervalMs);
        return;
      }

      const data = (await res.json()) as RawPollResponse;
      if (data.cursor) {
        this.cursor = data.cursor;
      }

      if (data.signals && data.signals.length > 0) {
        this.currentIntervalMs = this.initialIntervalMs;
        for (const item of data.signals) {
          const signalMessage = this.parseSignalItem(item);
          if (signalMessage) {
            for (const sub of [...this.subscribers]) {
              sub(signalMessage);
            }
          }
        }
      } else {
        // Back off when no signals are available
        this.currentIntervalMs = Math.min(
          this.currentIntervalMs * 1.5,
          this.maxIntervalMs,
        );
      }
    } catch {
      this.currentIntervalMs = Math.min(
        this.currentIntervalMs * 1.5,
        this.maxIntervalMs,
      );
    } finally {
      this.pollInFlight = false;
      if (!this.isClosed) {
        this.reschedule(this.currentIntervalMs);
      }
    }
  }

  private parseSignalItem(item: RawPollItem): SignalMessage | null {
    const payload = (
      typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload
    ) as Record<string, unknown>;
    switch (item.type) {
      case 'offer':
        return {
          type: 'offer',
          data: {
            sessionId: (payload.sessionId as string) ?? this.sessionId,
            sdp: (payload.sdp as string) ?? '',
            capabilities: (payload.capabilities as string[]) ?? [],
          },
        };
      case 'answer':
        return {
          type: 'answer',
          data: {
            sessionId: (payload.sessionId as string) ?? this.sessionId,
            sdp: (payload.sdp as string) ?? '',
            approved: Boolean(payload.approved),
          },
        };
      case 'ice-candidate':
        return {
          type: 'ice-candidate',
          data: {
            sessionId: (payload.sessionId as string) ?? this.sessionId,
            candidate: (payload.candidate as string) ?? '',
            sdpMid: (payload.sdpMid as string | null) ?? null,
            sdpMLineIndex: (payload.sdpMLineIndex as number | null) ?? null,
          },
        };
      default:
        return null;
    }
  }
}

export interface WebSocketSignalTransportOptions {
  baseUrl: string;
  sessionId: string;
  /** Lấy access token hiện tại (để mint ticket). Trả null nếu không có. */
  getToken: () => Promise<string | null>;
  /**
   * Called on 401 when minting the ticket — refresh the access token, return
   * `null` if the refresh itself failed.
   */
  onUnauthorized?: () => Promise<string | null>;
  /** Bật reconnect (mặc định true). false → dùng cho test hoặc fallback-only. */
  reconnect?: boolean;
  /** Chuyển hẳn sang transport này sau khi WS thất bại N lần. */
  fallback?: SignalTransport;
  fetch?: typeof fetch;
  /** Số lần thử lại tối đa trước khi chuyển sang fallback. Mặc định 5. */
  maxRetries?: number;
}

/** Trần của backoff — trùng `maxIntervalMs` của `RESTPollingTransport`. */
const WS_MAX_BACKOFF_MS = 2000;
const WS_INITIAL_BACKOFF_MS = 200;

/**
 * The WebSocket signaling transport for the browser tab.
 *
 * Replaces the 200ms–2000ms poll loop with a push socket: the tab mints a
 * short-lived ticket over REST, opens `/api/ws/browser`, and the server pushes
 * signals as they are recorded. The REST `SignalTransport` remains as a
 * `fallback`, so a proxy that refuses the upgrade degrades to the old path
 * instead of breaking the session.
 *
 * Two invariants shape the reconnect logic:
 *
 * 1. The queue holds only signals that were never handed to a socket. A signal
 *    that was sent while `OPEN` is the server's from then on; the reconnect
 *    replays from `lastCursor` and the dedup is the signal id. Re-sending a
 *    delivered signal would make the peer call `setRemoteDescription` on an
 *    already-stable connection (D6).
 * 2. `lastCursor` is the signal UUID the server attached to the frame, never a
 *    client-side counter: it is the same id the REST poll cursor uses, so a
 *    fallback handover resumes exactly where the socket left off.
 */
export class WebSocketSignalTransport implements SignalTransport {
  private readonly baseUrl: string;
  private readonly sessionId: string;
  private readonly getToken: () => Promise<string | null>;
  private readonly onUnauthorized?: () => Promise<string | null>;
  private readonly reconnectEnabled: boolean;
  private readonly fallback?: SignalTransport;
  private readonly customFetch: typeof fetch;
  private readonly maxRetries: number;

  private ws: WebSocket | null = null;
  /** Signals never handed to a socket. Never cleared on close (D6). */
  private pending: SignalMessage[] = [];
  private retries = 0;
  /** UUID of the last signal frame delivered, sent as `after` on subscribe. */
  private lastCursor: string | null = null;
  private readonly subscribers: Array<(msg: SignalMessage) => void> = [];
  /**
   * Transport-level error frames (`error{code}`) are not `SignalMessage`s, so
   * they cannot go through `subscribers`; `PeerConnection` would drop them.
   * This is where a tab learns that its session is gone instead of waiting on
   * a handshake that can no longer complete.
   */
  private readonly errorHandlers: Array<(code: BrowserErrorCode) => void> = [];
  /** Set once the fallback takes over; every call delegates from then on. */
  private activeTransport: SignalTransport | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isClosed = false;
  /** True while the server's `subscribed` ack has not arrived yet. */
  private awaitingAck = false;
  /** True while the socket is open — gates immediate sends and dedup. */
  private open = false;

  constructor(options: WebSocketSignalTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.sessionId = options.sessionId;
    this.getToken = options.getToken;
    this.onUnauthorized = options.onUnauthorized;
    this.reconnectEnabled = options.reconnect ?? true;
    this.fallback = options.fallback;
    this.customFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? 5;
  }

  subscribe(handler: (msg: SignalMessage) => void): () => void {
    if (this.activeTransport) {
      // After handoff the fallback owns delivery, so a late subscriber must
      // land there rather than on a socket that will never open again.
      return this.activeTransport.subscribe(handler);
    }
    this.subscribers.push(handler);
    if (!this.ws && !this.isClosed) {
      void this.connect();
    }
    return () => {
      const idx = this.subscribers.indexOf(handler);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  /**
   * Observe transport-level error frames (`error{code}`).
   *
   * `SignalTransport.subscribe` carries `SignalMessage`s only; a tab that
   * wants to distinguish "the session ended" from "the network is slow" needs
   * this second channel. Returns an unsubscribe function.
   */
  onServerError(handler: (code: BrowserErrorCode) => void): () => void {
    this.errorHandlers.push(handler);
    return () => {
      const idx = this.errorHandlers.indexOf(handler);
      if (idx >= 0) this.errorHandlers.splice(idx, 1);
    };
  }

  async send(msg: SignalMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error('Transport closed');
    }
    if (this.activeTransport) {
      return this.activeTransport.send(msg);
    }
    const stamped = this.stampSession(msg);
    if (this.open && this.ws && !this.awaitingAck) {
      // Fire-and-forget: the socket is the delivery mechanism, and a signal
      // handed over once must never be handed over again (D6).
      this.ws.send(JSON.stringify({ type: 'signal', data: stamped }));
      return;
    }
    this.pending.push(stamped);
  }

  /**
   * Stamp the transport's `sessionId` onto the signal payload.
   *
   * `PeerConnection` builds every signal with `sessionId: ''` — it carries no
   * sessionId option (the REST transport re-stamps in its own `send`). Without
   * this the server's `normalizeBrowserFrame` sees an empty sessionId and
   * answers `VALIDATION_ERROR`, so the offer never reaches the agent and the
   * channel never opens. Re-assigning an existing key preserves its position,
   * so a payload that already carries the correct id serializes identically.
   */
  private stampSession(msg: SignalMessage): SignalMessage {
    return {
      ...msg,
      data: { ...msg.data, sessionId: this.sessionId },
    } as SignalMessage;
  }

  close(): void {
    this.isClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close(1000, 'normal');
    } catch {
      // The socket may already be closing; close() must stay idempotent.
    }
    this.ws = null;
    this.subscribers.length = 0;
    this.activeTransport?.close();
  }

  /**
   * Mint a ticket and open the socket.
   *
   * The mint runs the same one-retry-on-401 dance as `RESTPollingTransport`
   * (`withTokenRefresh`): a 401 triggers exactly one `onUnauthorized()` and
   * one retry, and a refresh that cannot produce a token hands the session to
   * the fallback instead of looping.
   *
   * A network error or a 5xx, though, is what a restarting server looks like:
   * that is a *transient* failure and is retried on the same backoff ladder as
   * a dropped socket. Only a failure the server will keep answering the same
   * way (no token, 401, other 4xx) hands over immediately.
   */
  private async connect(): Promise<void> {
    if (this.isClosed || this.activeTransport) return;

    let ticket: string | null = null;
    let transient = false;
    try {
      ticket = await this.mintTicket();
    } catch {
      // Network error or 5xx: the request never produced an answer.
      transient = true;
    }

    if (this.isClosed) return;

    if (!ticket) {
      if (transient) {
        this.scheduleReconnect();
      } else {
        this.handOffToFallback();
      }
      return;
    }

    const socket = new WebSocket(this.wsUrl(ticket));
    this.ws = socket;
    socket.onopen = () => {
      // A superseded socket can still fire `open` after `this.ws` was replaced.
      // Without this guard the stale open would set `awaitingAck` on the live
      // connection and send the subscribe frame into a dead socket — the ack
      // never arrives, and every later `send()` queues forever.
      if (this.isClosed || socket !== this.ws) return;
      this.open = true;
      this.retries = 0;
      this.sendSubscribeFrame(socket);
    };
    socket.onmessage = (event: MessageEvent) => {
      this.handleFrame(socket, event.data as string);
    };
    socket.onclose = () => {
      this.handleDisconnect();
    };
    socket.onerror = () => {
      // `close` always follows an error in the browser; the reconnect is
      // driven from `onclose` alone so a failed open cannot double-schedule.
    };
  }

  private wsUrl(ticket: string): string {
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    return `${wsBase}/api/ws/browser?ticket=${encodeURIComponent(ticket)}`;
  }

  /**
   * Mint a ticket, or `null` when the server answered in a way a retry cannot
   * fix (no token, 401 without a working refresh, other 4xx).
   *
   * A thrown error means the request never produced a usable answer (network
   * failure, 5xx) — the caller treats it as transient.
   */
  private async mintTicket(): Promise<string | null> {
    const token = await this.getToken();
    if (!token) return null;

    const attempt = async (t: string): Promise<Response> =>
      this.customFetch(`${this.baseUrl}/api/ws/ticket`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}` },
      });

    let res = await attempt(token);
    if (res.status === 401 && this.onUnauthorized) {
      const fresh = await this.onUnauthorized();
      if (!fresh) return null;
      res = await attempt(fresh);
    }
    if (res.status >= 500) {
      // The server is up but broken (or a proxy answered for a restarting
      // upstream): same class as a dropped socket.
      throw new Error(`ticket endpoint answered HTTP ${res.status}`);
    }
    if (!res.ok) return null;

    const body = (await res.json()) as { ticket?: string };
    return body.ticket ?? null;
  }

  private sendSubscribeFrame(socket: WebSocket): void {
    this.awaitingAck = true;
    socket.send(
      JSON.stringify({
        type: 'subscribe',
        data: { sessionId: this.sessionId, after: this.lastCursor },
      }),
    );
  }

  private handleFrame(socket: WebSocket, raw: string): void {
    if (this.isClosed || socket !== this.ws) return;

    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (frame.type) {
      case 'subscribed': {
        this.awaitingAck = false;
        const ack = frame.data as { hasMore?: boolean } | undefined;
        if (ack?.hasMore) {
          // The replay was paged (server hit its 200-row limit) and the server
          // is STILL in `replaying`, buffering every live push until the final
          // page arrives. Ask for the next page from the last id received —
          // `sendSubscribeFrame` sends `after: this.lastCursor`, which every
          // `signal` frame advanced. Do NOT flush `pending` here: the
          // subscription is not live yet, so anything sent now would be
          // replayed back to us on the final page.
          this.sendSubscribeFrame(socket);
          return;
        }
        this.flushPending(socket);
        return;
      }
      case 'signal': {
        const id = typeof frame.id === 'string' ? frame.id : null;
        if (id) this.lastCursor = id;
        const msg = frame.data as SignalMessage | undefined;
        if (!msg) return;
        for (const sub of [...this.subscribers]) {
          sub(msg);
        }
        return;
      }
      case 'error': {
        const code = frame.code as BrowserErrorCode | undefined;
        if (code) {
          for (const handler of [...this.errorHandlers]) {
            handler(code);
          }
        }
        if (frame.code === 'SESSION_TERMINATED') {
          // The session cannot complete; a reconnect would only replay the
          // same verdict. Hand over or stop.
          this.handOffToFallback();
        }
        return;
      }
      default:
        // `pong` and anything unknown need no handling.
        return;
    }
  }

  /** Send queued signals now that replay is complete. */
  private flushPending(socket: WebSocket): void {
    const queued = this.pending;
    this.pending = [];
    for (const msg of queued) {
      socket.send(JSON.stringify({ type: 'signal', data: msg }));
    }
  }

  private handleDisconnect(): void {
    this.open = false;
    this.awaitingAck = false;
    this.ws = null;
    this.scheduleReconnect();
  }

  /**
   * Schedule the next connection attempt on the backoff ladder, or hand over
   * once the budget is spent.
   *
   * Shared by the two transient-failure paths — a dropped socket and a failed
   * ticket mint — so a restarting server costs one ladder, not two.
   */
  private scheduleReconnect(): void {
    if (this.isClosed || this.activeTransport) return;

    if (!this.reconnectEnabled || this.retries >= this.maxRetries) {
      this.handOffToFallback();
      return;
    }

    const delay =
      Math.min(
        WS_INITIAL_BACKOFF_MS * 2 ** this.retries,
        WS_MAX_BACKOFF_MS,
      ) +
      (Math.random() * 100 - 50);
    this.retries += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /**
   * Hand the session to the fallback transport, permanently.
   *
   * The fallback's `subscribe` is registered directly with the caller's
   * handlers, and queued never-sent signals go over it once. A session that
   * already burned `maxRetries` reconnects must not keep trying the socket
   * while the REST path is sitting there working.
   */
  private handOffToFallback(): void {
    if (this.activeTransport || this.isClosed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close(1000, 'normal');
    } catch {
      // Already closed.
    }
    this.ws = null;

    if (!this.fallback) return;

    this.activeTransport = this.fallback;
    for (const sub of [...this.subscribers]) {
      this.fallback.subscribe(sub);
    }
    const queued = this.pending;
    this.pending = [];
    for (const msg of queued) {
      void this.fallback.send(msg).catch(() => {
        // The REST transport's own retry policy owns delivery from here.
      });
    }
  }
}

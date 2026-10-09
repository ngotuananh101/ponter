/**
 * Fleet push consumer over the existing browser WebSocket.
 *
 * The server pushes `{type:'fleet-changed'}` over `/api/ws/browser` (ADR-76: the
 * signaling socket is session-scoped, so this client is a dedicated, fleet-only
 * consumer rather than a reuse of `WebSocketSignalTransport`). The Dashboard
 * refetches devices/agents on receipt; a 60 s REST poll is the safety-net
 * fallback (spec §7.4 — no fallback transport here).
 *
 * Reconnect backoff mirrors the signaling transport (transport.ts:328-343,
 * 696-714): `WS_INITIAL_BACKOFF_MS = 200`, `WS_MAX_BACKOFF_MS = 2000`.
 */

import type { BrowserMessageInit, BrowserSocketMessage } from '@ponter/shared';

/** Backoff ceiling — identical to `WebSocketSignalTransport`. */
const WS_MAX_BACKOFF_MS = 2000;
const WS_INITIAL_BACKOFF_MS = 200;

/**
 * A uniform value in [0, 1) drawn from the platform CSPRNG.
 *
 * `Math.random()` is flagged by static analysis even where the value is only a
 * reconnect jitter; `crypto.getRandomValues` is available in every target
 * browser and in Node, and gives the same uniform distribution.
 */
function randomUnit(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0] ?? 0) / 2 ** 32;
}

/**
 * Narrow an inbound frame to the fleet invalidation.
 *
 * The literal is written against the shared `BrowserSocketMessage` union
 * (ADR-77) so it cannot drift from the wire contract, and the guard keeps the
 * access safe for non-object JSON (`null`, numbers, arrays).
 */
function isFleetChanged(
  frame: unknown,
): frame is Extract<BrowserSocketMessage, { type: 'fleet-changed' }> {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    (frame as { type?: unknown }).type === 'fleet-changed'
  );
}

export interface FleetSocketOptions {
  baseUrl: string;
  /** Current access token, or `null` if none. */
  getToken: () => Promise<string | null>;
  /** Refresh the access token; return `null` if the refresh failed. */
  onUnauthorized?: () => Promise<string | null>;
  /** Raised once per `{type:'fleet-changed'}` frame. */
  onFleetChanged: () => void;
  fetch?: typeof fetch;
}

export class FleetSocket {
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string | null>;
  private readonly onUnauthorized?: () => Promise<string | null>;
  private readonly onFleetChanged: () => void;
  private readonly customFetch: typeof fetch;

  private ws: WebSocket | null = null;
  private retries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: FleetSocketOptions) {
    this.baseUrl = options.baseUrl;
    this.getToken = options.getToken;
    this.onUnauthorized = options.onUnauthorized;
    this.onFleetChanged = options.onFleetChanged;
    this.customFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Open the socket (idempotent while a socket exists and not stopped). */
  start(): void {
    if (this.stopped || this.ws) return;
    void this.connect();
  }

  /** Permanently stop: clear the reconnect timer, best-effort unsubscribe-fleet, close. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        const frame: BrowserMessageInit = { type: 'unsubscribe-fleet' };
        this.ws.send(JSON.stringify(frame));
      } catch {
        // Socket may already be closing; best-effort only (ADR-74).
      }
      try {
        this.ws.close(1000, 'normal');
      } catch {
        // Already closed.
      }
      this.ws = null;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    let ticket: string | null = null;
    let transient = false;
    try {
      ticket = await this.mintTicket();
    } catch {
      // Network error or 5xx: the request never produced an answer.
      transient = true;
    }

    if (this.stopped) return;

    if (!ticket) {
      if (transient) {
        this.scheduleReconnect();
      }
      // No refreshable/4xx failure path for fleet: a non-transient, non-ticket
      // failure hands up to the 60s poll. There is no fallback transport.
      return;
    }

    const socket = new WebSocket(this.wsUrl(ticket));
    this.ws = socket;
    socket.onopen = () => {
      if (this.stopped || socket !== this.ws) return;
      this.retries = 0;
      const frame: BrowserMessageInit = { type: 'subscribe-fleet' };
      socket.send(JSON.stringify(frame));
    };
    socket.onmessage = (event: MessageEvent) => {
      this.handleMessage(socket, event.data as string);
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

  private handleMessage(_socket: WebSocket, raw: string): void {
    if (this.stopped) return;
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      // Malformed JSON: swallow.
      return;
    }
    if (isFleetChanged(frame)) {
      this.onFleetChanged();
    }
    // Unknown frames: ignore.
  }

  private handleDisconnect(): void {
    this.ws = null;
    this.scheduleReconnect();
  }

  /**
   * Schedule the next connection attempt on the backoff ladder.
   *
   * Mirrors `WebSocketSignalTransport.scheduleReconnect` (transport.ts:696-714):
   * `delay = min(WS_INITIAL_BACKOFF_MS * 2 ** retries, WS_MAX_BACKOFF_MS) +
   * round(randomUnit() * 100 - 50)`.
   */
  private scheduleReconnect(): void {
    if (this.stopped) return;

    // No max-retries/hard handoff for fleet: keep backing off until stopped;
    // the 60s poll outside the socket is the durability net.
    const delay =
      Math.min(WS_INITIAL_BACKOFF_MS * 2 ** this.retries, WS_MAX_BACKOFF_MS) +
      Math.round(randomUnit() * 100 - 50);
    this.retries += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}

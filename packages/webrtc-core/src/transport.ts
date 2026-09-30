import type { SignalTransport } from './types';
import type { SignalMessage } from '@ponter/shared';

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

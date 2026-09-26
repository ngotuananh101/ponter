import type { SignalTransport } from './types';
import type { SignalMessage } from '@remote/shared';

export interface RESTPollingTransportOptions {
  baseUrl: string;
  sessionId: string;
  token: string;
  fetch?: typeof fetch;
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
  private readonly token: string;
  private readonly customFetch: typeof fetch;
  private readonly initialIntervalMs: number;
  private readonly maxIntervalMs: number;

  private currentIntervalMs: number;
  private cursor: string | null = null;
  private isClosed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly subscribers: Array<(msg: SignalMessage) => void> = [];

  constructor(options: RESTPollingTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.sessionId = options.sessionId;
    this.token = options.token;
    this.customFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.initialIntervalMs = options.initialIntervalMs ?? 200;
    this.maxIntervalMs = options.maxIntervalMs ?? 2000;
    this.currentIntervalMs = this.initialIntervalMs;
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

    const res = await this.customFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      // The transport is session-scoped, so it stamps the session id onto the
      // wire payload. `PeerConnection` builds signals without one because the
      // spec's `PeerConnectionOptions` carries no sessionId; re-assigning an
      // existing key preserves its position, so payloads that already carry the
      // correct id serialize identically.
      body: JSON.stringify({ ...msg.data, sessionId: this.sessionId }),
    });

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

    try {
      const query = this.cursor
        ? `?after=${encodeURIComponent(this.cursor)}`
        : '';
      const url = `${this.baseUrl}/api/signal/poll/${encodeURIComponent(this.sessionId)}${query}`;

      const res = await this.customFetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

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

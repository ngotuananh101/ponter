import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketSignalTransport } from '../src/transport';
import type { SignalMessage } from '@ponter/shared';

/**
 * A minimal fake for the browser `WebSocket` API.
 *
 * The transport only uses `readyState`, `send`, `close`, `onopen`,
 * `onmessage`, `onclose`, `onerror`, and `close()`'s `code`/`reason`
 * arguments — enough to drive every branch of the reconnect state machine
 * without a real socket.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  readonly url: string;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Test helper: the socket's `open` event fired. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Test helper: deliver a frame from the server. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Test helper: the server closed the socket. */
  serverClose(code = 1006, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** Test helper: frames this socket received, parsed. */
  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;

function installFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!socket) throw new Error('no WebSocket was opened');
  return socket;
}

function okTicketFetch(ticket = 'tkt_1'): ReturnType<typeof vi.fn> {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ ticket, expiresIn: 15 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

const offer: SignalMessage = {
  type: 'offer',
  data: { sessionId: 'sess_1', sdp: 'v=0', capabilities: ['terminal'] },
};

describe('WebSocketSignalTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeWebSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket =
      ORIGINAL_WEBSOCKET;
  });

  describe('ticket minting', () => {
    it('mints a ticket with the current access token and opens the ws url', async () => {
      const fetchSpy = okTicketFetch('tkt_abc');
      const transport = new WebSocketSignalTransport({
        baseUrl: 'https://api.example.com',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fetch: fetchSpy as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.example.com/api/ws/ticket',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer access_1',
          }),
        }),
      );
      // https → wss, ticket url-encoded into the query string.
      expect(lastSocket().url).toBe(
        'wss://api.example.com/api/ws/browser?ticket=tkt_abc',
      );

      transport.close();
    });

    it('refreshes once on a 401 and retries the mint', async () => {
      const authHeaders: string[] = [];
      const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
        const auth =
          (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
        authHeaders.push(auth);
        if (auth === 'Bearer stale') {
          return new Response('{}', { status: 401 });
        }
        return new Response(JSON.stringify({ ticket: 'tkt_2' }), {
          status: 200,
        });
      });
      const refresh = vi.fn(async () => 'fresh');

      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'stale',
        onUnauthorized: refresh,
        fetch: fetchSpy as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(authHeaders).toEqual(['Bearer stale', 'Bearer fresh']);
      expect(lastSocket().url).toContain('ticket=tkt_2');

      transport.close();
    });

    it('falls back without looping when the refresh itself fails', async () => {
      const fetchSpy = vi.fn(
        async () => new Response('{}', { status: 401 }),
      );
      const refresh = vi.fn(async () => null);
      const fallback = {
        send: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        close: vi.fn(),
      };

      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'stale',
        onUnauthorized: refresh,
        fallback,
        fetch: fetchSpy as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // Exactly one mint attempt and one refresh attempt, then the fallback
      // takes over — the `withTokenRefresh` pattern never retries with a
      // token it does not have, so a gone token cannot become a hot loop.
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fallback.subscribe).toHaveBeenCalledTimes(1);

      transport.close();
    });

    it('falls back when there is no token to mint with', async () => {
      const fetchSpy = okTicketFetch();
      const fallback = {
        send: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        close: vi.fn(),
      };

      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => null,
        fallback,
        fetch: fetchSpy as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fallback.subscribe).toHaveBeenCalledTimes(1);

      transport.close();
    });
  });

  describe('subscribe and queue', () => {
    it('queues sends made before the socket opens and flushes after subscribed', async () => {
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // Not open yet: the signal must not be lost.
      await transport.send(offer);
      const socket = lastSocket();
      expect(socket.sent).toEqual([]);

      socket.open();
      // The subscribe frame is sent on open; the queued signal waits for the
      // server's `subscribed` ack so replay is complete before new traffic.
      expect(socket.sentFrames()).toEqual([
        {
          type: 'subscribe',
          data: { sessionId: 'sess_1', after: null },
        },
      ]);

      socket.deliver({
        type: 'subscribed',
        data: { sessionId: 'sess_1', after: null, hasMore: false },
      });

      const frames = socket.sentFrames();
      expect(frames).toHaveLength(2);
      expect(frames[1]).toMatchObject({ type: 'signal', data: { type: 'offer' } });

      transport.close();
    });

    it('sends immediately when open and never re-sends a delivered signal', async () => {
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const socket = lastSocket();
      socket.open();
      socket.deliver({
        type: 'subscribed',
        data: { sessionId: 'sess_1', after: null, hasMore: false },
      });

      await transport.send(offer);
      expect(socket.sentFrames()).toHaveLength(2);

      // A reconnect must not replay a signal that already reached the server:
      // the queue holds only never-sent signals (D6).
      socket.serverClose();
      await vi.advanceTimersByTimeAsync(1000);
      lastSocket().open();

      const reconnectFrames = lastSocket().sentFrames();
      expect(reconnectFrames).toEqual([
        { type: 'subscribe', data: { sessionId: 'sess_1', after: null } },
      ]);

      transport.close();
    });
  });

  describe('cursor tracking', () => {
    it('tracks the last delivered signal id and sends it as `after` on resubscribe', async () => {
      const handler = vi.fn();
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(handler);
      await vi.advanceTimersByTimeAsync(0);
      const socket = lastSocket();
      socket.open();
      socket.deliver({
        type: 'subscribed',
        data: { sessionId: 'sess_1', after: null, hasMore: false },
      });

      socket.deliver({
        type: 'signal',
        data: offer,
        id: 'sig_1',
      });
      expect(handler).toHaveBeenCalledWith(offer);

      socket.serverClose();
      await vi.advanceTimersByTimeAsync(1000);
      const reconnected = lastSocket();
      reconnected.open();

      expect(reconnected.sentFrames()).toEqual([
        {
          type: 'subscribe',
          data: { sessionId: 'sess_1', after: 'sig_1' },
        },
      ]);

      transport.close();
    });

    it('ignores pong frames and keeps fanning out signal frames', async () => {
      const handler = vi.fn();
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(handler);
      await vi.advanceTimersByTimeAsync(0);
      const socket = lastSocket();
      socket.open();
      socket.deliver({ type: 'pong' });

      const answer: SignalMessage = {
        type: 'answer',
        data: { sessionId: 'sess_1', sdp: 'v=0', approved: true },
      };
      socket.deliver({ type: 'signal', data: answer, id: 'sig_2' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(answer);

      transport.close();
    });
  });

  describe('reconnect backoff', () => {
    it('reconnects with exponential backoff capped at 2000ms, jittered by ±50ms', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // zero jitter
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(FakeWebSocket.instances).toHaveLength(1);

      // 1st reconnect: 200ms
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(199);
      expect(FakeWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(2);

      // 2nd: 400ms
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(399);
      expect(FakeWebSocket.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(3);

      // 3rd: 800ms
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(800);
      expect(FakeWebSocket.instances).toHaveLength(4);

      // 4th: 1600ms
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(1600);
      expect(FakeWebSocket.instances).toHaveLength(5);

      // 5th: capped at 2000ms, not 3200
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(1999);
      expect(FakeWebSocket.instances).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(6);

      transport.close();
    });

    it('applies jitter of at most ±50ms to the backoff delay', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.99); // +49ms
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      lastSocket().serverClose();

      await vi.advanceTimersByTimeAsync(248);
      expect(FakeWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(2);

      transport.close();
    });

    it('resets the backoff after a successful connection', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // Burn two reconnect levels: 200 + 400.
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(200);
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(400);
      expect(FakeWebSocket.instances).toHaveLength(3);

      // A successful open resets the ladder.
      lastSocket().open();
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(200);
      expect(FakeWebSocket.instances).toHaveLength(4);

      transport.close();
    });

    it('does not reconnect when reconnect is false', async () => {
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        reconnect: false,
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(FakeWebSocket.instances).toHaveLength(1);

      transport.close();
    });
  });

  describe('fallback', () => {
    it('delegates to the fallback after maxRetries and flushes pending signals', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const fallback = {
        send: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        close: vi.fn(),
      };
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fallback,
        maxRetries: 2,
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);

      await transport.send(offer);
      expect(fallback.send).not.toHaveBeenCalled();

      // Retry 1 (200ms), retry 2 (400ms), then the next failure hands over.
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(200);
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(400);
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(0);

      expect(fallback.subscribe).toHaveBeenCalledTimes(1);
      expect(fallback.send).toHaveBeenCalledWith(offer);

      // Everything from here on is the fallback's job.
      await transport.send(offer);
      expect(fallback.send).toHaveBeenCalledTimes(2);

      transport.close();
      expect(fallback.close).toHaveBeenCalled();
    });

    it('closes the socket instead of retrying when there is no fallback', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        maxRetries: 1,
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);

      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(200);
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(FakeWebSocket.instances).toHaveLength(2);

      transport.close();
    });

    it('stops the queue from growing once the fallback owns the session', async () => {
      const fallback = {
        send: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        close: vi.fn(),
      };
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fallback,
        maxRetries: 0,
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(0);

      await transport.send(offer);
      expect(fallback.send).toHaveBeenCalledWith(offer);

      transport.close();
    });

    it('delegates subscribers added after handoff to the fallback', async () => {
      const fallback = {
        send: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        close: vi.fn(),
      };
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fallback,
        maxRetries: 0,
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(0);
      expect(fallback.subscribe).toHaveBeenCalledTimes(1);

      const late = vi.fn();
      transport.subscribe(late);
      expect(fallback.subscribe).toHaveBeenCalledTimes(2);
      expect(fallback.subscribe).toHaveBeenLastCalledWith(late);

      transport.close();
    });

    it('hands a SESSION_TERMINATED frame to the fallback without reconnecting', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const fallback = {
        send: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
        close: vi.fn(),
      };
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fallback,
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const socket = lastSocket();
      socket.open();
      socket.deliver({ type: 'error', code: 'SESSION_TERMINATED' });
      await vi.advanceTimersByTimeAsync(10_000);

      // A terminated session cannot be revived by a reconnect: no new socket
      // is opened and the REST path takes over at once.
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(fallback.subscribe).toHaveBeenCalledTimes(1);
      expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'normal' }]);

      transport.close();
    });
  });

  describe('close', () => {
    it('is idempotent and does not throw before the socket is open', () => {
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      expect(() => transport.close()).not.toThrow();
      expect(() => transport.close()).not.toThrow();
    });

    it('closes the live socket with code 1000', async () => {
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const socket = lastSocket();
      socket.open();

      transport.close();

      expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'normal' }]);
    });

    it('cancels a pending reconnect', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      lastSocket().open();

      lastSocket().serverClose();
      transport.close();
      await vi.advanceTimersByTimeAsync(10_000);

      // The pending reconnect timer must not fire after close.
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('stops delivering signals after close', async () => {
      const handler = vi.fn();
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(handler);
      await vi.advanceTimersByTimeAsync(0);
      const socket = lastSocket();
      socket.open();
      transport.close();

      socket.deliver({ type: 'signal', data: offer, id: 'sig_9' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('rejects send after close instead of queueing forever', async () => {
      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fetch: okTicketFetch() as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      transport.close();

      await expect(transport.send(offer)).rejects.toThrow('Transport closed');
    });
  });
});

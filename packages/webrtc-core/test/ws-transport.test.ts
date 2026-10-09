import type { Mock } from 'vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketSignalTransport } from '../src/transport';
import type { WebSocketSignalTransportOptions } from '../src/transport';
import type { SignalMessage } from '@ponter/shared';
import type { SignalTransport } from '../src/types';
import {
  FakeWebSocket,
  ORIGINAL_WEBSOCKET,
  installFakeWebSocket,
  lastSocket,
  mockRandomUnit,
} from './fake-websocket';

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

interface FakeFallback extends SignalTransport {
  send: Mock<(msg: SignalMessage) => Promise<void>>;
  subscribe: Mock<(handler: (msg: SignalMessage) => void) => () => void>;
  close: Mock<() => void>;
}

function makeFallback(): FakeFallback {
  return {
    send: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    close: vi.fn(),
  };
}

/** Build a transport with the standard ticket stub. */
function makeTransport(
  options: Partial<WebSocketSignalTransportOptions> = {},
): WebSocketSignalTransport {
  return new WebSocketSignalTransport({
    baseUrl: 'http://test',
    sessionId: 'sess_1',
    getToken: async () => 'access_1',
    fetch: okTicketFetch() as unknown as typeof fetch,
    ...options,
  });
}

/**
 * Open the transport's first socket and complete the subscribe handshake, so
 * the connection is live and later frames can be delivered.
 */
async function openLive(
  transport: WebSocketSignalTransport,
  handler: (msg: SignalMessage) => void = () => {},
): Promise<FakeWebSocket> {
  transport.subscribe(handler);
  await vi.advanceTimersByTimeAsync(0);
  const socket = lastSocket();
  socket.open();
  socket.deliver({
    type: 'subscribed',
    data: { sessionId: 'sess_1', after: null, hasMore: false },
  });
  return socket;
}

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
      const fetchSpy = vi.fn(async () => new Response('{}', { status: 401 }));
      const refresh = vi.fn(async () => null);
      const fallback = makeFallback();

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
      const fallback = makeFallback();

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

    it('retries a transient mint failure (network error) instead of falling back at once', async () => {
      mockRandomUnit(0.5);
      let failing = true;
      const fetchSpy = vi.fn(async () => {
        if (failing) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ ticket: 'tkt_late' }), {
          status: 200,
        });
      });
      const fallback = makeFallback();

      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fallback,
        fetch: fetchSpy as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // A restarting server is a transient failure: the first mint fails, the
      // transport backs off, and the retry succeeds — no fallback, no socket
      // abandoned while the server comes back.
      expect(fallback.subscribe).not.toHaveBeenCalled();
      expect(FakeWebSocket.instances).toHaveLength(0);

      failing = false;
      await vi.advanceTimersByTimeAsync(200);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(lastSocket().url).toContain('ticket=tkt_late');

      transport.close();
    });

    it('falls back after maxRetries consecutive transient mint failures', async () => {
      mockRandomUnit(0.5);
      const fetchSpy = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      const fallback = makeFallback();

      const transport = new WebSocketSignalTransport({
        baseUrl: 'http://test',
        sessionId: 'sess_1',
        getToken: async () => 'access_1',
        fallback,
        maxRetries: 1,
        fetch: fetchSpy as unknown as typeof fetch,
      });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(fallback.subscribe).not.toHaveBeenCalled();

      // One retry, then the budget is spent.
      await vi.advanceTimersByTimeAsync(200);
      expect(fallback.subscribe).toHaveBeenCalledTimes(1);
      expect(FakeWebSocket.instances).toHaveLength(0);

      transport.close();
    });
  });

  describe('subscribe and queue', () => {
    it('queues sends made before the socket opens and flushes after subscribed', async () => {
      const transport = makeTransport();

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
      expect(frames[1]).toMatchObject({
        type: 'signal',
        data: { type: 'offer' },
      });

      transport.close();
    });

    it('stamps the transport sessionId onto signals built with an empty one', async () => {
      // `PeerConnection` builds every signal with `sessionId: ''` (it has no
      // sessionId option), and the REST transport re-stamps it in `send()`.
      // The socket path must do the same: the server's `normalizeBrowserFrame`
      // rejects an empty sessionId with VALIDATION_ERROR, so an unstamped
      // offer never reaches the agent and the channel never opens.
      const transport = makeTransport();
      const socket = await openLive(transport);

      const unstamped: SignalMessage = {
        type: 'offer',
        data: { sessionId: '', sdp: 'v=0', capabilities: ['terminal'] },
      };
      await transport.send(unstamped);

      expect(socket.sentFrames()[1]).toMatchObject({
        type: 'signal',
        data: { type: 'offer', data: { sessionId: 'sess_1' } },
      });

      transport.close();
    });

    it('sends immediately when open and never re-sends a delivered signal', async () => {
      const transport = makeTransport();
      const socket = await openLive(transport);

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
      const transport = makeTransport();
      const socket = await openLive(transport, handler);

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

    it('requests the next replay page while the server reports hasMore', async () => {
      // A replay that hits the server's 200-row page limit arrives as
      // `subscribed{hasMore: true}`, and the server STAYS in `replaying`,
      // buffering every live push. If the client ignores `hasMore` it never
      // asks for page 2, so it receives no further signal for the rest of the
      // session — a silent hang with no error. The client must re-subscribe
      // from the last id it actually received, and must NOT flush its pending
      // queue yet (the subscription is not live until the final page).
      const transport = makeTransport();

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const socket = lastSocket();
      socket.open();

      // Page 1: one signal, then the ack that says more pages follow.
      socket.deliver({ type: 'signal', data: offer, id: 'sig_200' });
      socket.deliver({
        type: 'subscribed',
        data: { sessionId: 'sess_1', after: 'sig_200', hasMore: true },
      });

      expect(socket.sentFrames()).toEqual([
        { type: 'subscribe', data: { sessionId: 'sess_1', after: null } },
        { type: 'subscribe', data: { sessionId: 'sess_1', after: 'sig_200' } },
      ]);

      // A send during pagination is queued, not fired: the server is not live.
      await transport.send(offer);
      expect(socket.sentFrames()).toHaveLength(2);

      // Final page: replay is complete, so the queue flushes.
      socket.deliver({
        type: 'subscribed',
        data: { sessionId: 'sess_1', after: 'sig_205', hasMore: false },
      });

      const frames = socket.sentFrames();
      expect(frames).toHaveLength(3);
      expect(frames[2]).toMatchObject({
        type: 'signal',
        data: { type: 'offer' },
      });

      transport.close();
    });

    it('ignores a late open from a socket that is no longer current', async () => {
      // Every socket callback must confirm it still owns `this.ws`. A stray
      // `onopen` from a superseded socket would set `awaitingAck = true` on the
      // CURRENT connection and never clear it (the dead socket sends no ack),
      // so every later `send()` would queue forever — a silent hang.
      const transport = makeTransport();

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const first = lastSocket();
      first.open();
      first.deliver({
        type: 'subscribed',
        data: { sessionId: 'sess_1', after: null, hasMore: false },
      });

      // Drop the first socket and let the reconnect build a second one.
      first.serverClose();
      await vi.advanceTimersByTimeAsync(1000);
      const second = lastSocket();
      expect(second).not.toBe(first);
      second.open();
      second.deliver({
        type: 'subscribed',
        data: { sessionId: 'sess_1', after: null, hasMore: false },
      });

      const before = second.sentFrames().length;
      // The dead socket's open event arrives late; it must be a no-op.
      first.open();
      await transport.send(offer);

      const frames = second.sentFrames();
      expect(frames).toHaveLength(before + 1);
      expect(frames[before]).toMatchObject({
        type: 'signal',
        data: { type: 'offer' },
      });

      transport.close();
    });

    it('ignores pong frames and keeps fanning out signal frames', async () => {
      const handler = vi.fn();
      const transport = makeTransport();
      const socket = await openLive(transport, handler);

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
      mockRandomUnit(0.5); // zero jitter
      const transport = makeTransport();

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
      mockRandomUnit(0.99); // +49ms
      const transport = makeTransport();

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
      mockRandomUnit(0.5);
      const transport = makeTransport();

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
      const transport = makeTransport({ reconnect: false });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(FakeWebSocket.instances).toHaveLength(1);

      transport.close();
    });
  });

  describe('server error frames', () => {
    it('fans error codes out to onServerError handlers', async () => {
      const seen: string[] = [];
      const transport = makeTransport();

      transport.onServerError((code) => seen.push(code));
      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const socket = lastSocket();
      socket.open();

      // NOT_FOUND first: after SESSION_TERMINATED the transport hands the
      // session off and stops reading this socket, so that code is the last
      // one a handler can observe on this connection.
      socket.deliver({ type: 'error', code: 'NOT_FOUND' });
      socket.deliver({ type: 'error', code: 'SESSION_TERMINATED' });

      expect(seen).toEqual(['NOT_FOUND', 'SESSION_TERMINATED']);

      transport.close();
    });

    it('unsubscribes an onServerError handler', async () => {
      const seen: string[] = [];
      const transport = makeTransport();

      const off = transport.onServerError((code) => seen.push(code));
      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const socket = lastSocket();
      socket.open();

      off();
      socket.deliver({ type: 'error', code: 'NOT_FOUND' });

      expect(seen).toEqual([]);

      transport.close();
    });
  });

  describe('fallback', () => {
    it('delegates to the fallback after maxRetries and flushes pending signals', async () => {
      mockRandomUnit(0.5);
      const fallback = makeFallback();
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
      mockRandomUnit(0.5);
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
      const fallback = makeFallback();
      const transport = makeTransport({ fallback, maxRetries: 0 });

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      lastSocket().serverClose();
      await vi.advanceTimersByTimeAsync(0);

      await transport.send(offer);
      expect(fallback.send).toHaveBeenCalledWith(offer);

      transport.close();
    });

    it('delegates subscribers added after handoff to the fallback', async () => {
      const fallback = makeFallback();
      const transport = makeTransport({ fallback, maxRetries: 0 });

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
      mockRandomUnit(0.5);
      const fallback = makeFallback();
      const transport = makeTransport({ fallback });

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
      const transport = makeTransport();

      expect(() => transport.close()).not.toThrow();
      expect(() => transport.close()).not.toThrow();
    });

    it('closes the live socket with code 1000', async () => {
      const transport = makeTransport();

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const socket = lastSocket();
      socket.open();

      transport.close();

      expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'normal' }]);
    });

    it('cancels a pending reconnect', async () => {
      mockRandomUnit(0.5);
      const transport = makeTransport();

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
      const transport = makeTransport();

      transport.subscribe(handler);
      await vi.advanceTimersByTimeAsync(0);
      const socket = lastSocket();
      socket.open();
      transport.close();

      socket.deliver({ type: 'signal', data: offer, id: 'sig_9' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('rejects send after close instead of queueing forever', async () => {
      const transport = makeTransport();

      transport.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      transport.close();

      await expect(transport.send(offer)).rejects.toThrow('Transport closed');
    });
  });
});

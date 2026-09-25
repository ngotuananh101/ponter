import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RESTPollingTransport } from '../src/transport';
import type { SignalMessage } from '@remote/shared';

describe('RESTPollingTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts offer signal to /api/signal/offer', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: 'sig_1', sessionId: 'sess_1', type: 'offer' }),
          { status: 201 },
        ),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const msg: SignalMessage = {
      type: 'offer',
      data: { sessionId: 'sess_1', sdp: 'v=0', capabilities: ['terminal'] },
    };

    await transport.send(msg);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://test/api/signal/offer',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer token_abc',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(msg.data),
      }),
    );
    transport.close();
  });

  it('posts answer signal to /api/signal/answer', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: 'sig_2', sessionId: 'sess_1', type: 'answer' }),
          { status: 201 },
        ),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const msg: SignalMessage = {
      type: 'answer',
      data: { sessionId: 'sess_1', sdp: 'v=0', approved: true },
    };

    await transport.send(msg);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://test/api/signal/answer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(msg.data),
      }),
    );
    transport.close();
  });

  it('posts candidate signal to /api/signal/ice-candidate', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'sig_3',
            sessionId: 'sess_1',
            type: 'ice-candidate',
          }),
          { status: 201 },
        ),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const msg: SignalMessage = {
      type: 'ice-candidate',
      data: {
        sessionId: 'sess_1',
        candidate: 'cand_1',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    };

    await transport.send(msg);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://test/api/signal/ice-candidate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(msg.data),
      }),
    );
    transport.close();
  });

  it('polls signals, advances cursor, and notifies subscribers', async () => {
    let _callCount = 0;
    const fetchSpy = vi.fn(async (url: string) => {
      _callCount++;
      if (url.includes('/api/signal/poll')) {
        return new Response(
          JSON.stringify({
            signals: [
              {
                id: 'sig_10',
                sessionId: 'sess_1',
                type: 'offer',
                payload: { sessionId: 'sess_1', sdp: 'v=0', capabilities: [] },
              },
            ],
            cursor: 'sig_10',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      initialIntervalMs: 50,
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const received: SignalMessage[] = [];
    transport.subscribe((msg) => received.push(msg));

    // Advance timer to trigger first poll
    await vi.advanceTimersByTimeAsync(60);

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('offer');

    // Next poll includes cursor ?after=sig_10
    await vi.advanceTimersByTimeAsync(60);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/signal/poll/sess_1?after=sig_10'),
      expect.anything(),
    );

    transport.close();
  });

  it('stops polling immediately on close()', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ signals: [], cursor: null }), {
          status: 200,
        }),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      initialIntervalMs: 100,
      fetch: fetchSpy as unknown as typeof fetch,
    });

    transport.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(110);
    const countBeforeClose = fetchSpy.mock.calls.length;

    transport.close();

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSpy.mock.calls.length).toBe(countBeforeClose);
  });

  it('throws when sending after close()', async () => {
    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
    });
    transport.close();

    await expect(
      transport.send({
        type: 'offer',
        data: { sessionId: 'sess_1', sdp: 'v=0', capabilities: [] },
      }),
    ).rejects.toThrow('Transport closed');
  });

  it('backs off polling interval on empty results', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ signals: [], cursor: null }), {
          status: 200,
        }),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      initialIntervalMs: 100,
      maxIntervalMs: 400,
      fetch: fetchSpy as unknown as typeof fetch,
    });

    transport.subscribe(() => {});

    // Poll 1: 100ms
    await vi.advanceTimersByTimeAsync(110);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Poll 2: backed off (150ms)
    await vi.advanceTimersByTimeAsync(120);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // not yet
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    transport.close();
  });
});

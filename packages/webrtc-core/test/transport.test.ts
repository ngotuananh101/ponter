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
      data: { sessionId: '', sdp: 'v=0', capabilities: ['terminal'] },
    };

    await transport.send(msg);

    const body = JSON.parse(
      ((fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({ sessionId: 'sess_1' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://test/api/signal/offer',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer token_abc',
          'Content-Type': 'application/json',
        }),
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
      data: { sessionId: '', sdp: 'v=0', approved: true },
    };

    await transport.send(msg);

    const body = JSON.parse(
      ((fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({ sessionId: 'sess_1' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://test/api/signal/answer',
      expect.objectContaining({
        method: 'POST',
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
        sessionId: '',
        candidate: 'cand_1',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    };

    await transport.send(msg);

    const body = JSON.parse(
      ((fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit).body as string,
    );
    expect(body).toMatchObject({ sessionId: 'sess_1' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://test/api/signal/ice-candidate',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    transport.close();
  });

  it('polls signals, advances cursor, and notifies subscribers', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
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

    // Poll 1: at 100ms (initial interval)
    await vi.advanceTimersByTimeAsync(110);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Poll 2: backed off to 150ms, scheduled from the first poll's absolute
    // time (100ms), so it fires at exactly 250ms. Verify the boundary.
    await vi.advanceTimersByTimeAsync(139); // 110 + 139 = 249ms
    expect(fetchSpy).toHaveBeenCalledTimes(1); // 250ms not yet reached
    await vi.advanceTimersByTimeAsync(1); // 249 + 1 = 250ms
    expect(fetchSpy).toHaveBeenCalledTimes(2); // fires at 250ms

    transport.close();
  });
});

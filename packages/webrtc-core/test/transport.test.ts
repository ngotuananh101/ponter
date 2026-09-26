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

  it('throws when send() receives a non-2xx response', async () => {
    // Mutant #1 (Week 4 R24): deleting the `!res.ok` throw at
    // src/transport.ts:82-87 leaves the suite green. A signal that D1 refused
    // must not look like a delivered signal, or the peer negotiates against a
    // description the other side never received.
    const fetchSpy = vi.fn(
      async () => new Response('session is terminated', { status: 409 }),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      fetch: fetchSpy as unknown as typeof fetch,
    });

    await expect(
      transport.send({
        type: 'offer',
        data: { sessionId: '', sdp: 'v=0', capabilities: ['terminal'] },
      }),
    ).rejects.toThrow('Failed to send signal offer: HTTP 409');

    transport.close();
  });

  it('includes the status and response body in the send() error message', async () => {
    // R30: Week 4 spec §4.7 names this error path; only the fact of throwing
    // was untested, and the message is what a caller debugs with.
    const fetchSpy = vi.fn(
      async () =>
        new Response('{"code":"SESSION_NOT_ACTIVE"}', { status: 409 }),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      fetch: fetchSpy as unknown as typeof fetch,
    });

    await expect(
      transport.send({
        type: 'ice-candidate',
        data: {
          sessionId: '',
          candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host',
          sdpMid: null,
          sdpMLineIndex: null,
        },
      }),
    ).rejects.toThrow(
      'Failed to send signal ice-candidate: HTTP 409 {"code":"SESSION_NOT_ACTIVE"}',
    );

    transport.close();
  });

  it('backs off polling interval when fetch rejects', async () => {
    // R30: src/transport.ts:170-174 catches a thrown fetch and backs off.
    // Without it a Worker that is down turns into a hot retry loop.
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      initialIntervalMs: 100,
      maxIntervalMs: 400,
      fetch: fetchSpy as unknown as typeof fetch,
    });

    transport.subscribe(() => {});

    await vi.advanceTimersByTimeAsync(110);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(139); // 249ms — not yet
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 250ms — backed off to 150ms
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    transport.close();
  });

  it('backs off polling interval on a non-2xx response', async () => {
    // Mutant #3 (Week 4 R24): deleting the `!res.ok` branch at
    // src/transport.ts:138-146 leaves the suite green against a body that is
    // not JSON, because the catch at :170-174 applies the identical 1.5x
    // backoff. The branch is only observable when the error response carries
    // a JSON body that a successful poll would act on: without the guard the
    // 500 is parsed, the signal resets the interval to initialIntervalMs, and
    // the next poll fires at 200ms instead of 250ms.
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            signals: [
              {
                id: 'sig_1',
                sessionId: 'sess_1',
                type: 'ice-candidate',
                payload: { sessionId: 'sess_1', candidate: 'candidate:1' },
              },
            ],
            cursor: null,
          }),
          { status: 500 },
        ),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      initialIntervalMs: 100,
      maxIntervalMs: 400,
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const received: string[] = [];
    transport.subscribe((m) => received.push(m.type));

    // Poll 1 at 100ms -> 500 -> back off to 150ms, scheduled from t=100ms.
    await vi.advanceTimersByTimeAsync(110);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(139); // t=249ms — not yet
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // t=250ms — second poll
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // The signal in the 500 body must NOT have been delivered: the guard
    // returns before parsing. Without the guard this is ['ice-candidate'].
    expect(received).toEqual([]);

    transport.close();
  });
});

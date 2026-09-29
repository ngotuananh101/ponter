import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RESTPollingTransport } from '../src/transport';

// The polling loop, unlike `send`, is where a 401 actually bites: a long
// session spends most of its life inside it. Before this was routed through
// `withTokenRefresh` it backed off to its 2000ms cap and retried silently
// forever, leaving the user watching a tab that never opens.
describe('RESTPollingTransport token refresh in the poll loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes on 401 from poll, not just from send', async () => {
    const authHeaders: string[] = [];
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth =
        (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
      authHeaders.push(auth);
      if (auth === 'Bearer stale') {
        return new Response('{}', { status: 401 });
      }
      return new Response(JSON.stringify({ signals: [], cursor: null }), {
        status: 200,
      });
    });

    const refresh = vi.fn(async () => 'fresh');
    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'stale',
      fetch: fetchSpy as unknown as typeof fetch,
      onUnauthorized: refresh,
    });

    transport.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(250);

    expect(refresh).toHaveBeenCalled();
    expect(authHeaders).toContain('Bearer fresh');

    transport.close();
  });

  it('stops refreshing once the token is good, instead of every poll', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ signals: [], cursor: null }), {
          status: 200,
        }),
    );

    const refresh = vi.fn(async () => 'fresh');
    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'stale',
      fetch: fetchSpy as unknown as typeof fetch,
      onUnauthorized: refresh,
    });

    transport.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(2000);

    // A refresh on every single poll would hammer the refresh endpoint for the
    // whole life of a healthy session.
    expect(refresh).not.toHaveBeenCalled();

    transport.close();
  });
});

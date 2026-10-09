import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTerminalStore } from '../stores/terminal';
import { tokenStorage } from '../services/token-storage';
import type { RESTPollingTransport } from '@ponter/webrtc-core';
import type * as WebRtcCore from '@ponter/webrtc-core';

// The bug this pins: the store's `onUnauthorized` re-read storage instead of
// calling the refresh endpoint, so the transport retried with the same expired
// token and the poll loop backed off to its cap, 401-ing forever. Every
// transport test injected a fake callback returning a hardcoded 'fresh' token,
// so the broken callback passed all of them.
//
// Here the store drives the REAL `RESTPollingTransport` (the fake peer only
// captures it) against the REAL `ApiClient` fed by a mocked fetch: the retry
// can only carry a new token if the callback actually called
// `/api/auth/refresh`.
const { mockFetch } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  return { mockFetch };
});

let capturedTransport: RESTPollingTransport | null = null;

vi.mock('@ponter/webrtc-core', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRtcCore>();

  class FakePeerConnection {
    dataChannels = { onMessage: vi.fn(() => () => {}), sendJson: vi.fn() };

    constructor(
      public readonly peer: unknown,
      public readonly transport: unknown,
      public readonly options: unknown,
    ) {
      capturedTransport = transport as RESTPollingTransport;
    }

    start = vi.fn(async () => {});
    waitForChannel = vi.fn(async () => ({ readyState: 'open' as const }));
    onConnectionStateChange = vi.fn(() => () => {});
    close = vi.fn(async () => {});
  }

  return {
    ...actual,
    PeerConnection: FakePeerConnection,
    createBrowserAdapter: vi.fn(() => ({})),
  };
});

const { authMock, cryptoMock } = vi.hoisted(() =>
  require('./helpers/terminal-mocks.ts'),
);

vi.mock('../stores/auth', () => authMock());
vi.mock('@ponter/crypto', () => cryptoMock());

interface FetchCall {
  url: string;
  auth: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function respond(url: string, auth: string): Response {
  if (url.endsWith('/api/auth/refresh')) {
    return new Response(
      JSON.stringify({
        token: 'fresh-access',
        refreshToken: 'fresh-refresh',
        expiresIn: 900,
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  }
  if (url.endsWith('/api/sessions')) {
    return new Response(JSON.stringify({ id: 'session-1' }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }
  if (url.endsWith('/api/webrtc/ice-servers')) {
    return new Response(JSON.stringify({ iceServers: [] }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }
  if (url.match(/\/api\/agents\/[^/]+$/)) {
    return new Response(JSON.stringify({ signingPublicKey: 'agent-key' }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }
  if (url.includes('/api/signal/poll/')) {
    if (auth === 'Bearer stale-access') {
      return new Response(
        JSON.stringify({
          error: 'Invalid or expired token',
          code: 'UNAUTHORIZED',
        }),
        { status: 401, headers: JSON_HEADERS },
      );
    }
    return new Response(JSON.stringify({ signals: [], cursor: null }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }
  return new Response('Not found', { status: 404 });
}

describe('terminal store token refresh on poll 401', () => {
  let calls: FetchCall[] = [];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    capturedTransport = null;
    calls = [];
    setActivePinia(createPinia());
    localStorage.clear();
    await tokenStorage.setTokens({
      accessToken: 'stale-access',
      refreshToken: 'valid-refresh',
    });

    mockFetch.mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(url);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const auth = headers['Authorization'] ?? '';
        calls.push({ url: urlStr, auth });
        return respond(urlStr, auth);
      },
    );
  });

  afterEach(() => {
    capturedTransport?.close();
    vi.useRealTimers();
  });

  it('calls /api/auth/refresh and retries the poll with the new token', async () => {
    const store = useTerminalStore();

    await store.openTab('agent-1');
    expect(capturedTransport).not.toBeNull();

    capturedTransport!.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(250);

    const refreshCalls = calls.filter((c) =>
      c.url.endsWith('/api/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);

    const pollAuths = calls
      .filter((c) => c.url.includes('/api/signal/poll/'))
      .map((c) => c.auth);
    expect(pollAuths[0]).toBe('Bearer stale-access');
    expect(pollAuths).toContain('Bearer fresh-access');
  });
});

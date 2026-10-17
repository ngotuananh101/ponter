import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-user-data') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
}));

import { createApiClient } from '@ponter/api-client';
import { FleetManager } from '../fleet';
import { SessionManager, SessionTokenStorage } from '../session';
import { applyServerUrlChange } from '../server-url';

/**
 * Issue #150: the packaged app built its `ApiClient` and `FleetManager` once at
 * boot from the config that existed then. A server URL entered afterwards in
 * Server Setup was persisted but never applied, so login kept hitting the
 * localhost fallback and failed with a bare "fetch failed". These tests pin the
 * runtime reconfiguration: one call must repoint the shared client, repoint the
 * fleet, and drop the old server's tokens without any network call.
 */
function buildRuntime() {
  const storage = {
    getAccessToken: vi.fn(async () => 'stale-access-token'),
    getRefreshToken: vi.fn(async () => 'stale-refresh-token'),
    setTokens: vi.fn(async () => {}),
    clearTokens: vi.fn(async () => {}),
  };
  const mockFetch = vi.fn();
  const apiClient = createApiClient({
    baseUrl: 'http://localhost:8787',
    storage,
    fetch: mockFetch as unknown as typeof fetch,
  });
  const keychain = {
    getSecret: vi.fn(() => 'stale-refresh-token'),
    storeSecret: vi.fn(),
    deleteSecret: vi.fn(),
  };
  const session = new SessionManager(apiClient, keychain as any);
  const fleet = new FleetManager(apiClient, session, { baseUrl: '' });

  return { apiClient, storage, mockFetch, session, keychain, fleet };
}

describe('applyServerUrlChange (Issue #150)', () => {
  let runtime: ReturnType<typeof buildRuntime>;

  beforeEach(() => {
    runtime = buildRuntime();
  });

  afterEach(() => {
    runtime.fleet.destroy();
  });

  it('repoints the shared api client at the new server', async () => {
    await applyServerUrlChange(runtime, 'https://ponter.ponta.dev/');

    expect(runtime.apiClient.http.baseUrl).toBe('https://ponter.ponta.dev');
  });

  it('repoints the fleet manager so its WebSocket targets the new server', async () => {
    await applyServerUrlChange(runtime, 'https://ponter.ponta.dev');

    expect(runtime.fleet.getBaseUrl()).toBe('https://ponter.ponta.dev');
  });

  it('clears the previous server tokens without contacting it', async () => {
    await applyServerUrlChange(runtime, 'https://ponter.ponta.dev');

    // Tokens minted by the old server are useless against the new one, so they
    // must be dropped locally. A logout request would target the OLD host —
    // the one we may be running away from — so nothing may be sent there.
    expect(runtime.storage.clearTokens).toHaveBeenCalled();
    expect(runtime.session.accessToken).toBeNull();

    const requestedUrls = runtime.mockFetch.mock.calls.map(([url]) =>
      String(url),
    );
    expect(
      requestedUrls.filter((url) => url.includes('localhost:8787')),
    ).toEqual([]);
  });

  it('is a no-op when the URL does not actually change', async () => {
    await applyServerUrlChange(runtime, 'http://localhost:8787/');

    expect(runtime.storage.clearTokens).not.toHaveBeenCalled();
    expect(runtime.keychain.deleteSecret).not.toHaveBeenCalled();
    expect(runtime.apiClient.http.baseUrl).toBe('http://localhost:8787');
  });
});

/**
 * BE finding B1 on PR #151: purging locally does not cancel a refresh that is
 * already in flight. Before the generation guard, a refresh aimed at the OLD
 * server resumed after the purge and wrote its tokens straight back into the
 * in-memory slot and the keychain. The app then sent the old server's bearer
 * token to the new host and posted the old refresh token there.
 *
 * These use the real `SessionTokenStorage` and `SessionManager` — the bug lived
 * in the interaction between them and the client, so mocks would hide it.
 */
describe('server switch during an in-flight refresh (Issue #150 B1)', () => {
  function buildLiveRuntime() {
    const secrets = new Map<string, string>();
    const keychain = {
      getSecret: vi.fn((key: string) => secrets.get(key) ?? null),
      storeSecret: vi.fn((key: string, value: string) => {
        secrets.set(key, value);
      }),
      deleteSecret: vi.fn((key: string) => {
        secrets.delete(key);
      }),
    };

    const requests: { url: string; auth?: string }[] = [];
    let releaseRefresh!: (response: Response) => void;
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url: String(url), auth: headers['Authorization'] });

      if (String(url).includes('/api/auth/refresh')) {
        return await new Promise<Response>((resolve) => {
          releaseRefresh = resolve;
        });
      }
      // Everything else on the old server is unauthorized, which is what makes
      // the fleet poll kick off a refresh.
      return new Response(
        JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const storage = new SessionTokenStorage(keychain as any);
    const apiClient = createApiClient({
      baseUrl: 'https://old.example',
      storage,
      fetch: mockFetch as unknown as typeof fetch,
    });
    const session = new SessionManager(apiClient, keychain as any);
    const fleet = new FleetManager(apiClient, session, {
      baseUrl: 'https://old.example',
    });

    return {
      apiClient,
      storage,
      session,
      fleet,
      keychain,
      secrets,
      requests,
      mockFetch,
      release: (response: Response) => releaseRefresh(response),
    };
  }

  it('does not restore the old server credentials after the switch', async () => {
    const live = buildLiveRuntime();
    live.secrets.set('refresh_token', 'OLD-SERVER-REFRESH');

    const inFlight = live.session.refreshSession();
    await vi.waitFor(() => expect(live.requests.length).toBeGreaterThan(0));

    await applyServerUrlChange(live, 'https://new.example');

    // The old server answers only now, after the purge.
    live.release(
      new Response(
        JSON.stringify({
          token: 'OLD-SERVER-TOKEN-2',
          refreshToken: 'OLD-SERVER-REFRESH-2',
          user: { id: 'u1', username: 'alice', role: 'admin' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(inFlight).rejects.toMatchObject({ code: 'SERVER_CHANGED' });

    expect(live.session.accessToken).toBeNull();
    expect(live.secrets.has('refresh_token')).toBe(false);
    expect(live.keychain.storeSecret).not.toHaveBeenCalledWith(
      'refresh_token',
      'OLD-SERVER-REFRESH-2',
    );

    // No later request may carry the old server's bearer token to the new host.
    const toNewServer = live.requests.filter((r) =>
      r.url.startsWith('https://new.example'),
    );
    expect(
      toNewServer.filter((r) => r.auth?.includes('OLD-SERVER-TOKEN')),
    ).toEqual([]);

    live.fleet.destroy();
  });

  it('bumps the generation before any await, so no window is left open', async () => {
    const live = buildLiveRuntime();
    live.secrets.set('refresh_token', 'OLD-SERVER-REFRESH');

    const before = live.apiClient.http.serverGeneration;
    const change = applyServerUrlChange(live, 'https://new.example');

    // Synchronously after the call — before awaiting it — the generation must
    // already have moved, otherwise a refresh resolving in that window would
    // still be treated as current.
    expect(live.apiClient.http.serverGeneration).toBeGreaterThan(before);

    await change;
    live.fleet.destroy();
  });
});

/**
 * PM probe on `b12acf6`: the epoch guard covered the refresh *response*, but
 * two read paths still leaked the previous server's credentials to the new
 * host. Both read from `SessionTokenStorage`, so the guard belongs there — it
 * is the single choke point for `getAccessToken()` (Bearer header) and
 * `getRefreshToken()` (refresh POST), regardless of how fast the adapter purges.
 */
describe('SessionTokenStorage generation awareness (Issue #150 B1)', () => {
  function buildStorage() {
    const secrets = new Map<string, string>();
    const keychain = {
      getSecret: vi.fn((key: string) => secrets.get(key) ?? null),
      storeSecret: vi.fn((key: string, value: string) => {
        secrets.set(key, value);
      }),
      deleteSecret: vi.fn((key: string) => {
        secrets.delete(key);
      }),
    };
    let generation = 0;
    const storage = new SessionTokenStorage(keychain as any, () => generation);
    return {
      storage,
      secrets,
      keychain,
      bump: () => {
        generation += 1;
      },
    };
  }

  it('stops serving the access token once the generation moves', async () => {
    const live = buildStorage();
    await live.storage.setTokens({
      accessToken: 'OLD-ACCESS',
      refreshToken: 'OLD-REFRESH',
    });
    expect(await live.storage.getAccessToken()).toBe('OLD-ACCESS');

    live.bump();

    // The adapter has not purged yet (keychain I/O is async in reality); the
    // storage itself must refuse to hand out the previous server's credential.
    expect(await live.storage.getAccessToken()).toBeNull();
    expect(live.secrets.get('refresh_token')).toBe('OLD-REFRESH');
  });

  it('stops serving the refresh token once the generation moves', async () => {
    const live = buildStorage();
    await live.storage.setTokens({
      accessToken: 'OLD-ACCESS',
      refreshToken: 'OLD-REFRESH',
    });
    expect(await live.storage.getRefreshToken()).toBe('OLD-REFRESH');

    live.bump();

    expect(await live.storage.getRefreshToken()).toBeNull();
  });

  it('serves tokens again once they are set for the new generation', async () => {
    const live = buildStorage();
    await live.storage.setTokens({
      accessToken: 'OLD-ACCESS',
      refreshToken: 'OLD-REFRESH',
    });

    live.bump();
    await live.storage.setTokens({
      accessToken: 'NEW-ACCESS',
      refreshToken: 'NEW-REFRESH',
    });

    expect(await live.storage.getAccessToken()).toBe('NEW-ACCESS');
    expect(await live.storage.getRefreshToken()).toBe('NEW-REFRESH');
  });
});

/**
 * The end-to-end leaks PM reproduced. These run the real storage, session and
 * fleet against a recording fetch, so they fail for the same reason the
 * packaged app leaked.
 */
describe('no previous-server credential reaches the new host (Issue #150 B1)', () => {
  function buildRuntime(options: { purgeDelayMs?: number } = {}) {
    const secrets = new Map<string, string>([['refresh_token', 'OLD-REFRESH']]);
    const keychain = {
      getSecret: vi.fn((key: string) => secrets.get(key) ?? null),
      storeSecret: vi.fn((key: string, value: string) => {
        secrets.set(key, value);
      }),
      deleteSecret: vi.fn((key: string) => {
        secrets.delete(key);
      }),
    };

    const requests: { url: string; auth?: string; body?: string }[] = [];
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        url: String(url),
        auth: headers['Authorization'],
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      // Everything is unauthorized: that is what drives the retry/refresh path.
      return new Response(
        JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    });

    let apiClient!: ReturnType<typeof createApiClient>;
    const storage = new SessionTokenStorage(keychain as any, () => {
      return apiClient.http.serverGeneration;
    });
    if (options.purgeDelayMs) {
      const originalClear = storage.clearTokens.bind(storage);
      storage.clearTokens = async () => {
        await new Promise((resolve) =>
          setTimeout(resolve, options.purgeDelayMs),
        );
        await originalClear();
      };
    }

    apiClient = createApiClient({
      baseUrl: 'https://old.example',
      storage,
      fetch: mockFetch as unknown as typeof fetch,
    });
    const session = new SessionManager(apiClient, keychain as any);
    const fleet = new FleetManager(apiClient, session, {
      baseUrl: 'https://old.example',
    });

    return { apiClient, storage, session, fleet, keychain, secrets, requests };
  }

  /** Seed the in-memory access token without going through a login. */
  async function seedOldTokens(runtime: ReturnType<typeof buildRuntime>) {
    await runtime.storage.setTokens({
      accessToken: 'OLD-ACCESS',
      refreshToken: 'OLD-REFRESH',
    });
  }

  it('sends no request carrying the previous server bearer token to the new host', async () => {
    const runtime = buildRuntime();
    await seedOldTokens(runtime);

    await applyServerUrlChange(runtime, 'https://new.example');
    // Let the fleet's reconnection attempt run.
    await new Promise((resolve) => setTimeout(resolve, 80));

    const leaked = runtime.requests.filter(
      (r) =>
        r.url.startsWith('https://new.example') &&
        r.auth?.includes('OLD-ACCESS'),
    );
    expect(leaked).toEqual([]);

    runtime.fleet.destroy();
  });

  it('never posts the previous server refresh token to the new host when the purge is slow', async () => {
    const runtime = buildRuntime({ purgeDelayMs: 120 });
    await seedOldTokens(runtime);

    await applyServerUrlChange(runtime, 'https://new.example');
    // Long enough for the ticket request, its 401, and the refresh retry.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const leaked = runtime.requests.filter(
      (r) =>
        r.url.startsWith('https://new.example') &&
        r.body?.includes('OLD-REFRESH'),
    );
    expect(leaked).toEqual([]);

    runtime.fleet.destroy();
  });
});

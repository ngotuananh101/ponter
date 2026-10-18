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
  // Ticket #154: the switch stops the agent through the SAME serialized
  // control service the UI and tray use (BLOCKING-3), never the supervisor.
  const agentControl = {
    stop: vi.fn(async () => ({ ok: true, message: 'Agent stopped' })),
  };
  const onServerChanged = vi.fn(async () => {});

  return {
    apiClient,
    storage,
    mockFetch,
    session,
    keychain,
    fleet,
    agentControl,
    onServerChanged,
  };
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
    expect(runtime.agentControl.stop).not.toHaveBeenCalled();
    expect(runtime.onServerChanged).not.toHaveBeenCalled();
  });

  /**
   * PM ruling R1: the sidecar holds the old server's credential in its env and
   * keeps reconnecting to it, so it must be stopped BEFORE the credential is
   * purged and the local identity is forgotten.
   */
  it('stops the agent before purging credentials and forgetting the device', async () => {
    await applyServerUrlChange(runtime, 'https://ponter.ponta.dev');

    expect(runtime.agentControl.stop).toHaveBeenCalledTimes(1);
    expect(runtime.onServerChanged).toHaveBeenCalledTimes(1);

    const stopOrder = runtime.agentControl.stop.mock.invocationCallOrder[0]!;
    const forgetOrder = runtime.onServerChanged.mock.invocationCallOrder[0]!;

    // The agent must be down before its server-scoped credential is dropped.
    // (The refresh-token purge deliberately starts EARLIER — before the fleet
    // repoints — so an in-flight request cannot leak it to the new host.)
    expect(stopOrder).toBeLessThan(forgetOrder);
  });

  it('still switches servers when stopping the agent fails', async () => {
    runtime.agentControl.stop.mockRejectedValue(new Error('stop timed out'));

    await expect(
      applyServerUrlChange(runtime, 'https://ponter.ponta.dev'),
    ).resolves.toBe(true);

    expect(runtime.apiClient.http.baseUrl).toBe('https://ponter.ponta.dev');
    expect(runtime.onServerChanged).toHaveBeenCalled();
    expect(runtime.storage.clearTokens).toHaveBeenCalled();
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
      // Ticket #154: the switch stops the agent via the serialized control
      // service and forgets the local device.
      agentControl: { stop: vi.fn(async () => ({ ok: true })) },
      onServerChanged: vi.fn(async () => {}),
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

  /**
   * BE finding B3: requiring an explicit stamp made the adapter refuse tokens
   * it had never seen `setTokens()` for — i.e. the refresh token that survived
   * a restart in the keychain. Session restore then failed with
   * "No refresh token available" and the user had to log in again every launch.
   */
  it('adopts the current generation for a token persisted before this process started', async () => {
    const secrets = new Map<string, string>([
      ['refresh_token', 'PERSISTED-REFRESH'],
    ]);
    const keychain = {
      getSecret: vi.fn((key: string) => secrets.get(key) ?? null),
      storeSecret: vi.fn(),
      deleteSecret: vi.fn(),
    };
    let generation = 7;
    const storage = new SessionTokenStorage(keychain as any, () => generation);

    // Fresh process: nothing stamped yet, the keychain still holds a token.
    expect(await storage.getRefreshToken()).toBe('PERSISTED-REFRESH');

    // The adopted stamp is the generation in force at that moment.
    generation = 8;
    expect(await storage.getRefreshToken()).toBeNull();
  });

  /**
   * The counter-regression for B3: "adopt on null" must not reopen leak #2.
   * `clearTokens()` sets the purged marker synchronously — before its awaited
   * keychain delete finishes — so a read inside that window cannot adopt the
   * new generation and serve the old secret.
   */
  it('does not adopt a generation after a purge', async () => {
    const secrets = new Map<string, string>();
    const keychain = {
      getSecret: vi.fn((key: string) => secrets.get(key) ?? null),
      storeSecret: vi.fn((key: string, value: string) => {
        secrets.set(key, value);
      }),
      deleteSecret: vi.fn(),
    };
    let generation = 0;
    const storage = new SessionTokenStorage(keychain as any, () => generation);

    await storage.setTokens({
      accessToken: 'OLD-ACCESS',
      refreshToken: 'OLD-REFRESH',
    });

    // Simulate a slow purge: the keychain secret is still present when the
    // generation moves and clearTokens() has been entered but not finished.
    generation = 1;
    const purge = storage.clearTokens();
    expect(await storage.getRefreshToken()).toBeNull();
    expect(await storage.getAccessToken()).toBeNull();
    await purge;

    expect(await storage.getRefreshToken()).toBeNull();
    expect(await storage.getAccessToken()).toBeNull();
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

    return {
      apiClient,
      storage,
      session,
      fleet,
      keychain,
      secrets,
      requests,
      agentControl: { stop: vi.fn(async () => ({ ok: true })) },
      onServerChanged: vi.fn(async () => {}),
    };
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

  /**
   * BE finding B2: `refreshSession()` read the keychain directly, bypassing the
   * generation-aware storage, so only `HttpClient.doRefresh()` was protected.
   * The path is reachable in production — `retryOnceOn401()` is called from the
   * fleet poll, the WS ticket call, and every DeviceManager method.
   */
  it('refreshSession routes through the generation-aware storage', async () => {
    // A slow purge is what exposes the bypass: the keychain still holds the old
    // refresh token while `refreshSession()` reads it directly.
    const runtime = buildRuntime({ purgeDelayMs: 120 });
    await seedOldTokens(runtime);

    const change = applyServerUrlChange(runtime, 'https://new.example');

    // Inside the purge window: the old secret is still in the keychain, but the
    // generation has already moved. A direct keychain read leaks it.
    await expect(runtime.session.refreshSession()).rejects.toBeDefined();

    await change;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const leaked = runtime.requests.filter(
      (r) =>
        r.url.startsWith('https://new.example') &&
        r.body?.includes('OLD-REFRESH'),
    );
    expect(leaked).toEqual([]);

    runtime.fleet.destroy();
  });

  /**
   * BE finding B3: a fresh process whose keychain still holds a refresh token
   * must be able to restore the session. Requiring an explicit `setTokens()`
   * stamp made every restart look unauthenticated.
   */
  it('restores a persisted session after restart', async () => {
    const runtime = buildRuntime();
    // No seedOldTokens(): this is a brand-new process. The keychain already
    // holds the refresh token from the previous run.
    expect(await runtime.storage.getRefreshToken()).toBe('OLD-REFRESH');

    await expect(runtime.session.refreshSession()).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const refreshCalls = runtime.requests.filter((r) =>
      r.url.endsWith('/api/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);

    runtime.fleet.destroy();
  });
});

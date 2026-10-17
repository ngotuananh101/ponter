import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-user-data') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
}));

import { createApiClient } from '@ponter/api-client';
import { FleetManager } from '../fleet';
import { SessionManager } from '../session';
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
    expect(runtime.keychain.deleteSecret).toHaveBeenCalledWith('refresh_token');
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

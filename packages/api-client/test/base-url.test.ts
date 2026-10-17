import { describe, it, expect, vi } from 'vitest';
import { MemoryStorage, jsonResponse, makeClient } from './helpers';

/**
 * Issue #150: the desktop main process builds its `ApiClient` once at boot, so
 * changing the server URL in Server Setup left every later request pointed at
 * the old base (the localhost fallback) until the app restarted. `setBaseUrl`
 * is the controlled reconfiguration seam: it must normalise trailing slashes
 * exactly like the constructor and be the base used by every subsequent
 * request, including the refresh path.
 */
describe('HttpClient.setBaseUrl (Issue #150)', () => {
  it('normalises trailing slashes and routes later requests to the new base', async () => {
    const storage = new MemoryStorage();
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = makeClient(storage, mockFetch);

    expect(client.http.baseUrl).toBe('http://localhost:8787');

    client.http.setBaseUrl('https://ponter.ponta.dev///');
    expect(client.http.baseUrl).toBe('https://ponter.ponta.dev');

    await client.devices.list();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://ponter.ponta.dev/api/devices',
      expect.anything(),
    );
    expect(
      mockFetch.mock.calls.some(([url]) =>
        String(url).includes('localhost:8787'),
      ),
    ).toBe(false);
  });

  it('uses the new base for the refresh-token request', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({ accessToken: 'old', refreshToken: 'refresh-1' });
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        token: 'new',
        refreshToken: 'refresh-2',
        expiresIn: 60,
      }),
    );
    const client = makeClient(storage, mockFetch);

    client.http.setBaseUrl('https://ponter.ponta.dev');
    await client.http.refreshAccessToken();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://ponter.ponta.dev/api/auth/refresh',
      expect.anything(),
    );
  });

  it('keeps the base unchanged when set to the same URL', async () => {
    const storage = new MemoryStorage();
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = makeClient(storage, mockFetch);

    client.http.setBaseUrl('http://localhost:8787');
    expect(client.http.baseUrl).toBe('http://localhost:8787');

    await client.devices.list();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8787/api/devices',
      expect.anything(),
    );
  });
});

/**
 * Issue #150 (BE finding B1): repointing the client while a refresh is in
 * flight let the OLD server's response write its tokens back into storage after
 * the purge. The app then talked to the new server carrying the old server's
 * bearer token, and posted the old refresh token to the new host. The
 * generation counter makes a stale refresh a no-op.
 */
describe('HttpClient refresh generation guard (Issue #150 B1)', () => {
  it('exposes an incrementing serverGeneration', () => {
    const storage = new MemoryStorage();
    const client = makeClient(storage, vi.fn());

    const before = client.http.serverGeneration;
    client.http.setBaseUrl('https://new.example');
    expect(client.http.serverGeneration).toBeGreaterThan(before);
  });

  it('discards a refresh response that resolves after the server changed', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
    });
    // Seeding above goes through the same spy; only the refresh path matters.
    storage.setTokens.mockClear();
    storage.clearTokens.mockClear();

    let releaseRefresh!: (value: Response) => void;
    const mockFetch = vi.fn((url: string) => {
      if (String(url).includes('/api/auth/refresh')) {
        return new Promise<Response>((resolve) => {
          releaseRefresh = resolve;
        });
      }
      return Promise.resolve(
        jsonResponse({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401),
      );
    });
    const client = makeClient(storage, mockFetch as unknown as typeof fetch);

    // A normal request hits 401, which starts the refresh against the old base.
    const inFlight = client.devices.list();
    await vi.waitFor(() => expect(releaseRefresh).toBeTypeOf('function'));

    // The user switches servers while that refresh is still in flight.
    client.http.setBaseUrl('https://new.example');

    // The old server finally answers with fresh credentials.
    releaseRefresh(
      jsonResponse({
        token: 'OLD-SERVER-TOKEN',
        refreshToken: 'OLD-SERVER-REFRESH',
        expiresIn: 60,
      }),
    );

    await expect(inFlight).rejects.toMatchObject({ code: 'SERVER_CHANGED' });

    // Nothing from the old server may be stored, and the new server's (empty)
    // storage must not be purged either.
    expect(storage.setTokens).not.toHaveBeenCalled();
    expect(storage.clearTokens).not.toHaveBeenCalled();
    expect(await storage.getAccessToken()).toBe('old-access');
  });

  it('drops the in-flight refresh promise when the base changes', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({ accessToken: 'old', refreshToken: 'refresh-1' });

    const mockFetch = vi
      .fn()
      .mockImplementation(() => new Promise<Response>(() => {}));
    const client = makeClient(storage, mockFetch);

    // Start a refresh against the old server, then repoint.
    void client.http.refreshAccessToken();
    client.http.setBaseUrl('https://new.example');

    // A fresh call must issue a NEW request (the stale promise is not reused).
    mockFetch.mockResolvedValue(
      jsonResponse({ token: 't', refreshToken: 'r', expiresIn: 60 }),
    );
    await client.http.refreshAccessToken();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]![0]).toBe(
      'https://new.example/api/auth/refresh',
    );
  });
});

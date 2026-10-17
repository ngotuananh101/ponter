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

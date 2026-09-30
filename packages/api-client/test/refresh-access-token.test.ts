import { describe, it, expect, vi } from 'vitest';
import { MemoryStorage, jsonResponse, makeClient } from './helpers';

// The signaling transport polls outside `request()`, so it cannot lean on the
// automatic 401 retry and needs a way to ask for a refresh directly. That is
// what `refreshAccessToken` is for: it reuses the single-flight
// `refreshPromise`, returns the new token, and — unlike `request()` — reports a
// failed refresh as `null` instead of throwing, so the poll loop can back off
// rather than crash.
describe('HttpClient.refreshAccessToken', () => {
  it('returns the new access token after refreshing', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'expired-access',
      refreshToken: 'valid-refresh',
    });

    const mockFetch = vi.fn(async (url: RequestInfo | URL) => {
      if (url.toString().endsWith('/api/auth/refresh')) {
        return jsonResponse({
          token: 'fresh-access',
          refreshToken: 'fresh-refresh',
          expiresIn: 900,
        });
      }
      return new Response('Not found', { status: 404 });
    });
    const client = makeClient(storage, mockFetch);

    await expect(client.http.refreshAccessToken()).resolves.toBe(
      'fresh-access',
    );

    // The caller gets the token the transport should retry with, and storage
    // holds it for every other request path.
    await expect(storage.getAccessToken()).resolves.toBe('fresh-access');
  });

  it('returns null and notifies once when the refresh fails', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'expired-access',
      refreshToken: 'revoked-refresh',
    });

    const onAuthError = vi.fn();
    const mockFetch = vi.fn(async (url: RequestInfo | URL) => {
      if (url.toString().endsWith('/api/auth/refresh')) {
        return jsonResponse(
          { error: 'Refresh token revoked', code: 'TOKEN_REVOKED' },
          401,
        );
      }
      return new Response('Not found', { status: 404 });
    });
    const client = makeClient(storage, mockFetch, onAuthError);

    await expect(client.http.refreshAccessToken()).resolves.toBeNull();
    expect(storage.clearTokens).toHaveBeenCalled();
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it('shares one refresh between concurrent callers', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'expired-access',
      refreshToken: 'valid-refresh',
    });

    let refreshCalls = 0;
    const mockFetch = vi.fn(async (url: RequestInfo | URL) => {
      if (url.toString().endsWith('/api/auth/refresh')) {
        refreshCalls++;
        return jsonResponse({
          token: 'fresh-access',
          refreshToken: 'fresh-refresh',
          expiresIn: 900,
        });
      }
      return new Response('Not found', { status: 404 });
    });
    const client = makeClient(storage, mockFetch);

    const [first, second] = await Promise.all([
      client.http.refreshAccessToken(),
      client.http.refreshAccessToken(),
    ]);

    // Two polls hitting 401 at the same moment must not each refresh.
    expect(refreshCalls).toBe(1);
    expect(first).toBe('fresh-access');
    expect(second).toBe('fresh-access');
  });

  it('returns null when no refresh token is stored', async () => {
    const storage = new MemoryStorage();
    const client = makeClient(storage, vi.fn());

    await expect(client.http.refreshAccessToken()).resolves.toBeNull();
    expect(storage.clearTokens).toHaveBeenCalled();
  });
});

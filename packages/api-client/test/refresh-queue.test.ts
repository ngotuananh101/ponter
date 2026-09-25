import { describe, it, expect, vi } from 'vitest';
import { ApiClient } from '../src/index';
import type { TokenStorageAdapter, TokenPair } from '../src/types';

class MemoryStorage implements TokenStorageAdapter {
  tokens: TokenPair = { accessToken: '', refreshToken: '' };
  getAccessToken = vi.fn(() => this.tokens.accessToken || null);
  getRefreshToken = vi.fn(() => this.tokens.refreshToken || null);
  setTokens = vi.fn((t: TokenPair) => {
    this.tokens = t;
  });
  clearTokens = vi.fn(() => {
    this.tokens = { accessToken: '', refreshToken: '' };
  });
}

describe('Refresh Queue & Concurrency Tests', () => {
  it('7. Three concurrent 401s trigger exactly one refresh and retry all requests', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'expired-access',
      refreshToken: 'valid-refresh',
    });

    let refreshCallCount = 0;
    const mockFetch = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = url.toString();

        // Refresh endpoint
        if (urlStr.endsWith('/api/auth/refresh')) {
          refreshCallCount++;
          return new Response(
            JSON.stringify({
              token: 'fresh-access',
              refreshToken: 'valid-refresh',
              expiresIn: 900,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // Any resource endpoint
        const authHeader = (init?.headers as Record<string, string>)?.[
          'Authorization'
        ];
        if (authHeader === 'Bearer expired-access') {
          return new Response(
            JSON.stringify({ error: 'Token expired', code: 'UNAUTHORIZED' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (authHeader === 'Bearer fresh-access') {
          if (urlStr.endsWith('/api/users/me')) {
            return new Response(JSON.stringify({ user: { id: 'u1' } }), {
              status: 200,
            });
          }
          if (urlStr.endsWith('/api/devices')) {
            return new Response(JSON.stringify([{ id: 'd1' }]), {
              status: 200,
            });
          }
          if (urlStr.endsWith('/api/agents')) {
            return new Response(JSON.stringify([{ id: 'a1' }]), {
              status: 200,
            });
          }
        }

        return new Response('Not found', { status: 404 });
      },
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    // Fire 3 concurrent requests while token is expired
    const [userRes, devicesRes, agentsRes] = await Promise.all([
      client.users.me(),
      client.devices.list(),
      client.agents.list(),
    ]);

    expect(userRes).toEqual({ user: { id: 'u1' } });
    expect(devicesRes).toEqual([{ id: 'd1' }]);
    expect(agentsRes).toEqual([{ id: 'a1' }]);

    // Crucial assertion: exactly 1 refresh call took place!
    expect(refreshCallCount).toBe(1);
    expect(storage.setTokens).toHaveBeenCalledWith({
      accessToken: 'fresh-access',
      refreshToken: 'valid-refresh',
    });
  });

  it('8. A 401 from /api/auth/login does NOT trigger a refresh', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'token',
      refreshToken: 'valid-refresh',
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Invalid credentials',
          code: 'INVALID_CREDENTIALS',
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    await expect(client.auth.login('wrong', 'creds')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('9. A second 401 on a retried request throws instead of refreshing again', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'bad-access',
      refreshToken: 'bad-refresh',
    });

    // Return 401 on everything including refresh retry
    const mockFetch = vi.fn(async (url: RequestInfo | URL) => {
      if (url.toString().endsWith('/api/auth/refresh')) {
        return new Response(
          JSON.stringify({
            token: 'still-bad-access',
            refreshToken: 'bad-refresh',
            expiresIn: 900,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    await expect(client.users.me()).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });

    // Initial 401 + 1 refresh + 1 retry = 3 calls total (no infinite loop)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('10. Refresh failure clears tokens and invokes onAuthError once', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'expired-access',
      refreshToken: 'revoked-refresh',
    });

    const onAuthError = vi.fn();
    const mockFetch = vi.fn(async (url: RequestInfo | URL) => {
      if (url.toString().endsWith('/api/auth/refresh')) {
        return new Response(
          JSON.stringify({
            error: 'Refresh token revoked',
            code: 'TOKEN_REVOKED',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      onAuthError,
      fetch: mockFetch,
    });

    await expect(client.users.me()).rejects.toMatchObject({
      status: 401,
    });

    expect(storage.clearTokens).toHaveBeenCalled();
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it('11. A 401 from an auth path with default auth does NOT trigger a refresh', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({ accessToken: 'tok', refreshToken: 'valid-refresh' });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Invalid credentials',
          code: 'INVALID_CREDENTIALS',
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    // NOTE: deliberately NOT `auth: false` — this is the branch that exercises
    // the `isAuthPath` guard. Removing the guard would make this refresh and
    // call fetch twice.
    await expect(
      client.http.request('POST', '/api/auth/login', { body: {} }),
    ).rejects.toMatchObject({ status: 401 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

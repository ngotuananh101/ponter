import { describe, it, expect, vi } from 'vitest';
import { MemoryStorage, jsonResponse, makeClient } from './helpers';

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

        if (urlStr.endsWith('/api/auth/refresh')) {
          refreshCallCount++;
          return jsonResponse({
            token: 'fresh-access',
            refreshToken: 'valid-refresh',
            expiresIn: 900,
          });
        }

        const authHeader = (init?.headers as Record<string, string>)?.[
          'Authorization'
        ];
        if (authHeader === 'Bearer expired-access') {
          return jsonResponse(
            { error: 'Token expired', code: 'UNAUTHORIZED' },
            401,
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

    const client = makeClient(storage, mockFetch);

    // Fire 3 concurrent requests while the token is expired
    const [userRes, devicesRes, agentsRes] = await Promise.all([
      client.users.me(),
      client.devices.list(),
      client.agents.list(),
    ]);

    expect(userRes).toEqual({ user: { id: 'u1' } });
    expect(devicesRes).toEqual([{ id: 'd1' }]);
    expect(agentsRes).toEqual([{ id: 'a1' }]);

    // Crucial assertion: exactly 1 refresh call took place.
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

    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' },
          401,
        ),
      );
    const client = makeClient(storage, mockFetch);

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

    // 401 on everything, including the retry that follows the refresh.
    const mockFetch = vi.fn(async (url: RequestInfo | URL) => {
      if (url.toString().endsWith('/api/auth/refresh')) {
        return jsonResponse({
          token: 'still-bad-access',
          refreshToken: 'bad-refresh',
          expiresIn: 900,
        });
      }
      return jsonResponse({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    });

    const client = makeClient(storage, mockFetch);

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
        return jsonResponse(
          { error: 'Refresh token revoked', code: 'TOKEN_REVOKED' },
          401,
        );
      }
      return jsonResponse({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    });

    const client = makeClient(storage, mockFetch, onAuthError);

    await expect(client.users.me()).rejects.toMatchObject({ status: 401 });

    expect(storage.clearTokens).toHaveBeenCalled();
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it('11. A 401 from an auth path with default auth does NOT trigger a refresh', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({ accessToken: 'tok', refreshToken: 'valid-refresh' });

    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' },
          401,
        ),
      );
    const client = makeClient(storage, mockFetch);

    // NOTE: deliberately NOT `auth: false` — this is the branch that exercises
    // the `isAuthPath` guard. Removing the guard would make this refresh and
    // call fetch twice.
    await expect(
      client.http.request('POST', '/api/auth/login', { body: {} }),
    ).rejects.toMatchObject({ status: 401 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

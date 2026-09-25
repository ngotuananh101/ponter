import { describe, it, expect, vi } from 'vitest';
import { ApiClient } from '../src/index';
import type { TokenStorageAdapter, TokenPair } from '../src/types';

class MemoryStorage implements TokenStorageAdapter {
  private tokens: TokenPair = { accessToken: '', refreshToken: '' };
  getAccessToken = vi.fn(() => this.tokens.accessToken || null);
  getRefreshToken = vi.fn(() => this.tokens.refreshToken || null);
  setTokens = vi.fn((t: TokenPair) => {
    this.tokens = t;
  });
  clearTokens = vi.fn(() => {
    this.tokens = { accessToken: '', refreshToken: '' };
  });
}

describe('ApiClient general requests & resources', () => {
  it('1. Attaches Authorization: Bearer <token> when token is stored', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({ accessToken: 'access-123', refreshToken: 'refresh-456' });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 'dev-1' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    const res = await client.devices.list();
    expect(res).toEqual([{ id: 'dev-1' }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const callInit = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(callInit.headers).toMatchObject({
      Authorization: 'Bearer access-123',
    });
  });

  it('2. Omits the header when no token is stored', async () => {
    const storage = new MemoryStorage();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 'dev-1' }]), { status: 200 }),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    await client.devices.list();
    const callInit = mockFetch.mock.calls[0]![1] as RequestInit;
    expect((callInit.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('3. Parses { error, code, details } into ApiError with status and code', async () => {
    const storage = new MemoryStorage();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Username already taken',
          code: 'USERNAME_EXISTS',
          details: null,
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    await expect(
      client.auth.register({
        username: 'alice',
        password: 'password123',
        publicKey: 'pub-key-data',
      }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'USERNAME_EXISTS',
      message: 'Username already taken',
    });
  });

  it('4. Throws ApiError with code: NETWORK_ERROR when response body is not JSON', async () => {
    const storage = new MemoryStorage();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<html>Bad Gateway</html>', {
        status: 502,
        statusText: 'Bad Gateway',
      }),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    await expect(client.users.me()).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: 'NETWORK_ERROR',
      message: 'Bad Gateway',
    });
  });

  it('5. login persists the mapped token pair through the adapter', async () => {
    const storage = new MemoryStorage();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { id: 'u1', username: 'alice' },
          token: 'jwt-access-token',
          refreshToken: 'jwt-refresh-token',
          expiresIn: 900,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    const res = await client.auth.login('alice', 'password123');
    expect(res.user.username).toBe('alice');
    expect(storage.setTokens).toHaveBeenCalledWith({
      accessToken: 'jwt-access-token',
      refreshToken: 'jwt-refresh-token',
    });
  });

  it('6. logout sends the refresh token in the request body with Bearer auth', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({ accessToken: 'access-1', refreshToken: 'refresh-1' });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    const res = await client.auth.logout('refresh-1');
    expect(res.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const callInit = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(callInit.headers).toMatchObject({
      Authorization: 'Bearer access-1',
    });
    expect(JSON.parse(callInit.body as string)).toEqual({
      refreshToken: 'refresh-1',
    });
    expect(storage.clearTokens).toHaveBeenCalled();
  });
});

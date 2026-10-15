import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../session';

describe('SessionManager & Auth Classification (Issue #107)', () => {
  const apiClientMock = {
    post: vi.fn(),
    setToken: vi.fn(),
    clearToken: vi.fn(),
  };

  const keychainMock = {
    getSecret: vi.fn(),
    storeSecret: vi.fn(),
    deleteSecret: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies 401 UNAUTHORIZED as auth-fatal and purges keychain', async () => {
    keychainMock.getSecret.mockReturnValue('valid-refresh-token');
    apiClientMock.post.mockRejectedValue({
      status: 401,
      data: { message: 'Session expired' },
    });

    const session = new SessionManager(
      apiClientMock as any,
      keychainMock as any,
    );
    await expect(session.refreshSession()).rejects.toThrow(
      'AUTH_FAILED: UNAUTHORIZED',
    );
    expect(keychainMock.deleteSecret).toHaveBeenCalledWith('refresh_token');
  });

  it('treats 403 as non-fatal without wiping keychain (e.g. AGENT_LIMIT_REACHED)', async () => {
    keychainMock.getSecret.mockReturnValue('valid-refresh-token');
    apiClientMock.post.mockRejectedValue({
      status: 403,
      data: { message: 'AGENT_LIMIT_REACHED' },
    });

    const session = new SessionManager(
      apiClientMock as any,
      keychainMock as any,
    );
    await expect(session.refreshSession()).rejects.toThrow(
      'AGENT_LIMIT_REACHED',
    );
    expect(keychainMock.deleteSecret).not.toHaveBeenCalled();
  });

  it('retryOnceOn401 executes refresh and retries original request', async () => {
    let callCount = 0;
    const mockRequest = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const err: any = new Error('Unauthorized');
        err.status = 401;
        throw err;
      }
      return { success: true };
    });

    keychainMock.getSecret.mockReturnValue('refresh-token');
    apiClientMock.post.mockResolvedValueOnce({
      accessToken: 'new-access-token',
      refreshToken: 'rotated-refresh-token',
      user: { id: 'u1', username: 'alice', role: 'admin' },
    });

    const session = new SessionManager(
      apiClientMock as any,
      keychainMock as any,
    );
    const result = await session.retryOnceOn401(mockRequest);
    expect(result).toEqual({ success: true });
    expect(callCount).toBe(2);
    expect(keychainMock.storeSecret).toHaveBeenCalledWith(
      'refresh_token',
      'rotated-refresh-token',
    );
  });
});

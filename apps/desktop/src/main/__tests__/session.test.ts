import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../session';
import { ApiError } from '@ponter/api-client';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((buf: Buffer) => buf.toString()),
  },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

/**
 * Mock factory for ApiClient. The real ApiClient exposes:
 *  - `auth.login(username, password)` → LoginResponse `{ token, refreshToken, user }`
 *  - `auth.logout()` → `{ success: boolean }`
 *  - `http.request(method, path, options)` → typed response
 *  - `http.storage` → TokenStorageAdapter
 */
function createApiClientMock() {
  return {
    auth: {
      login: vi.fn(),
      logout: vi.fn(),
    },
    http: {
      request: vi.fn(),
      storage: {
        getAccessToken: vi.fn(),
        getRefreshToken: vi.fn(),
        setTokens: vi.fn(),
        clearTokens: vi.fn(),
      },
    },
  };
}

const keychainMock = {
  getSecret: vi.fn(),
  storeSecret: vi.fn(),
  deleteSecret: vi.fn(),
};

describe('SessionManager & Auth Classification (Issue #107)', () => {
  let apiClientMock: ReturnType<typeof createApiClientMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiClientMock = createApiClientMock();
  });

  it('classifies 401 UNAUTHORIZED as auth-fatal and purges keychain', async () => {
    keychainMock.getSecret.mockReturnValue('valid-refresh-token');
    apiClientMock.http.request.mockRejectedValue(
      new ApiError('Unauthorized', 401, 'UNAUTHORIZED'),
    );

    const session = new SessionManager(
      apiClientMock as any,
      keychainMock as any,
    );
    await expect(session.refreshSession()).rejects.toThrow(
      'AUTH_FAILED: UNAUTHORIZED',
    );
    expect(keychainMock.deleteSecret).toHaveBeenCalledWith('refresh_token');
  });

  it('treats 403 as non-fatal without wiping keychain', async () => {
    keychainMock.getSecret.mockReturnValue('valid-refresh-token');
    apiClientMock.http.request.mockRejectedValue(
      new ApiError('AGENT_LIMIT_REACHED', 403, 'AGENT_LIMIT_REACHED'),
    );

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
        throw new ApiError('Unauthorized', 401, 'UNAUTHORIZED');
      }
      return { success: true };
    });

    keychainMock.getSecret.mockReturnValue('refresh-token');
    apiClientMock.http.request.mockResolvedValueOnce({
      token: 'new-access-token',
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

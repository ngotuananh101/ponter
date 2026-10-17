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

/**
 * Issue #150: a bare "fetch failed" gave the user no way to tell which server
 * the client was actually pointed at — the packaged app shipped with the
 * localhost fallback while the UI showed the URL the user had typed. The
 * network-error path must name the base URL; every other error path keeps its
 * existing message and code.
 */
describe('SessionManager.login error reporting (Issue #150)', () => {
  let apiClientMock: ReturnType<typeof createApiClientMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiClientMock = createApiClientMock();
    (apiClientMock.http as any).baseUrl = 'http://localhost:8787';
  });

  it('names the base URL when login fails with a network error', async () => {
    apiClientMock.auth.login.mockRejectedValue(
      new ApiError('fetch failed', 0, 'NETWORK_ERROR'),
    );

    const session = new SessionManager(
      apiClientMock as any,
      keychainMock as any,
    );

    await expect(session.login('alice', 'secret')).rejects.toThrow(
      'Cannot reach http://localhost:8787 (network error)',
    );
  });

  it('keeps the server message for credential errors', async () => {
    apiClientMock.auth.login.mockRejectedValue(
      new ApiError('Invalid credentials', 401, 'INVALID_CREDENTIALS'),
    );

    const session = new SessionManager(
      apiClientMock as any,
      keychainMock as any,
    );

    await expect(session.login('alice', 'wrong')).rejects.toThrow(
      'Invalid credentials',
    );
  });

  it('preserves the API error code on the surfaced error', async () => {
    apiClientMock.auth.login.mockRejectedValue(
      new ApiError('fetch failed', 0, 'NETWORK_ERROR'),
    );

    const session = new SessionManager(
      apiClientMock as any,
      keychainMock as any,
    );

    // The message names the server; the code must survive too, otherwise the
    // renderer loses the only stable signal it can branch on (Issue #107).
    await expect(session.login('alice', 'secret')).rejects.toMatchObject({
      message: 'Cannot reach http://localhost:8787 (network error)',
      code: 'NETWORK_ERROR',
    });
  });
});

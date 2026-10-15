import type { ApiClient, TokenStorageAdapter } from '@ponter/api-client';
import type { KeychainService } from './keychain';
import type { UserProfile } from '../shared/ipc-types';
import type { ApiError } from '@ponter/api-client';

/**
 * In-memory access token storage (ADR-13/ADR-52/R8).
 *
 * Access tokens MUST never be written to keychain or disk.
 * Only refresh tokens are persisted via KeychainService.
 */
let inMemoryAccessToken: string | null = null;

/**
 * Token storage adapter that keeps access tokens in memory and delegates
 * refresh token storage to the keychain.
 */
class SessionTokenStorage implements TokenStorageAdapter {
  constructor(private keychain: KeychainService) {}

  async getAccessToken(): Promise<string | null> {
    return inMemoryAccessToken;
  }

  async getRefreshToken(): Promise<string | null> {
    return this.keychain.getSecret('refresh_token');
  }

  async setTokens(tokens: {
    accessToken: string;
    refreshToken: string;
  }): Promise<void> {
    inMemoryAccessToken = tokens.accessToken;
    if (tokens.refreshToken) {
      this.keychain.storeSecret('refresh_token', tokens.refreshToken);
    }
  }

  async clearTokens(): Promise<void> {
    inMemoryAccessToken = null;
    this.keychain.deleteSecret('refresh_token');
  }
}

export { SessionTokenStorage };

export class SessionManager {
  private apiClient: ApiClient;
  private keychain: KeychainService;
  private currentUser: UserProfile | null = null;

  constructor(apiClient: ApiClient, keychain: KeychainService) {
    this.apiClient = apiClient;
    this.keychain = keychain;
  }

  /**
   * The in-memory access token, used by the API client's storage adapter
   * and by callers that need to inspect auth state.
   */
  get accessToken(): string | null {
    return inMemoryAccessToken;
  }

  async login(username: string, password: string): Promise<UserProfile> {
    try {
      const resp = await this.apiClient.auth.login(username, password);
      // auth.login() already stored tokens via the storage adapter:
      // - access token in memory
      // - refresh token in keychain
      this.currentUser = resp.user;
      return resp.user;
    } catch (err: any) {
      throw new Error(err.data?.message || err.message || 'Login failed');
    }
  }

  async logout(): Promise<void> {
    try {
      await this.apiClient.auth.logout();
    } catch {
      // Swallowed on client logout
    } finally {
      this.currentUser = null;
      inMemoryAccessToken = null;
      this.keychain.deleteSecret('refresh_token');
    }
  }

  async refreshSession(): Promise<string> {
    const refreshToken = this.keychain.getSecret('refresh_token');
    if (!refreshToken) {
      this.currentUser = null;
      inMemoryAccessToken = null;
      throw new Error('AUTH_FAILED: UNAUTHORIZED');
    }

    try {
      const resp = await this.apiClient.http.request<{
        token: string;
        refreshToken: string;
        user?: UserProfile;
      }>('POST', '/api/auth/refresh', {
        body: { refreshToken },
      });

      inMemoryAccessToken = resp.token;
      if (resp.refreshToken) {
        this.keychain.storeSecret('refresh_token', resp.refreshToken);
      }
      if (resp.user) this.currentUser = resp.user;
      return resp.token;
    } catch (err: any) {
      if (err.status === 401 || err.statusCode === 401) {
        // Issue #107: 401 is auth-fatal — purge keychain
        this.currentUser = null;
        inMemoryAccessToken = null;
        this.keychain.deleteSecret('refresh_token');
        throw new Error('AUTH_FAILED: UNAUTHORIZED');
      }
      // Non-401 errors (e.g. 403 AGENT_LIMIT_REACHED) are non-fatal:
      // do NOT clear the keychain (Issue #107).
      if (err.status === 403 || err.statusCode === 403) {
        throw new Error(err.data?.message || err.message || 'Forbidden');
      }
      throw err;
    }
  }

  async retryOnceOn401<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (err.status === 401 || err.statusCode === 401) {
        await this.refreshSession();
        return await fn();
      }
      throw err;
    }
  }
}

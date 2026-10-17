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

/**
 * Build the error surfaced to the renderer while keeping the API's error code
 * reachable for callers in the main process (Issue #150: the code used to be
 * dropped on the floor here).
 */
function loginError(message: string, code?: string): Error {
  const error = new Error(message);
  if (code) {
    (error as Error & { code?: string }).code = code;
  }
  return error;
}

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
      // Issue #150: a bare "fetch failed" hides which server was actually
      // contacted, so a stale base URL looked like a network outage. Name the
      // base for transport failures (status 0); every other error keeps the
      // server-supplied message verbatim. The code travels with the message so
      // callers can still branch on it (e.g. NETWORK_ERROR).
      if (err?.status === 0 || err?.code === 'NETWORK_ERROR') {
        throw loginError(
          `Cannot reach ${this.apiClient.http.baseUrl} (network error)`,
          'NETWORK_ERROR',
        );
      }
      throw loginError(
        err.data?.message || err.message || 'Login failed',
        err.code,
      );
    }
  }

  async logout(): Promise<void> {
    try {
      await this.apiClient.auth.logout();
    } catch {
      // Swallowed on client logout
    } finally {
      // Awaited so the token purge finishes before logout() resolves and so the
      // floating promise is not left unhandled (typescript:S9383).
      // `clearLocalSession()` never rejects — it wraps the adapter call.
      await this.clearLocalSession();
    }
  }

  /**
   * Drop the local session without contacting the server (Issue #150).
   *
   * Used when the client is repointed at a different server: the refresh token
   * belongs to the old host, and a logout request would target that host — the
   * very one we may be unable to reach. Revoking it remotely is best-effort at
   * most, so the local purge is what matters here.
   *
   * Goes through the storage adapter so any adapter (in-memory + keychain today,
   * something else later) purges itself, then clears this module's own copy.
   */
  async clearLocalSession(): Promise<void> {
    this.currentUser = null;
    inMemoryAccessToken = null;
    try {
      await this.apiClient.http.storage.clearTokens();
    } catch {
      // A failing adapter must not block the server switch.
    }
    this.keychain.deleteSecret('refresh_token');
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

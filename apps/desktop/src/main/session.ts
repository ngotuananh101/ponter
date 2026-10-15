import type { KeychainService } from './keychain';
import type { UserProfile } from '../shared/ipc-types';

/**
 * Minimal client interface consumed by SessionManager.
 *
 * The full ApiClient is passed in production, but SessionManager only
 * needs these primitives: an HTTP POST, and token set/clear.
 */
export interface SessionApiClient {
  post: (path: string, body?: unknown) => Promise<unknown>;
  setToken: (token: string) => void;
  clearToken: () => void;
}

export class SessionManager {
  private client: SessionApiClient;
  private keychain: KeychainService;
  private currentUser: UserProfile | null = null;

  constructor(client: SessionApiClient, keychain: KeychainService) {
    this.client = client;
    this.keychain = keychain;
  }

  async login(username: string, password: string): Promise<UserProfile> {
    try {
      const resp: any = await this.client.post('/api/auth/login', {
        username,
        password,
      });
      this.currentUser = resp.user;
      this.client.setToken(resp.accessToken);
      if (resp.refreshToken) {
        this.keychain.storeSecret('refresh_token', resp.refreshToken);
      }
      return resp.user;
    } catch (err: any) {
      throw new Error(err.data?.message || err.message || 'Login failed');
    }
  }

  async logout(): Promise<void> {
    try {
      await this.client.post('/api/auth/logout', {});
    } catch {
      // Swallowed on client logout
    } finally {
      this.currentUser = null;
      this.client.clearToken();
      this.keychain.deleteSecret('refresh_token');
    }
  }

  async refreshSession(): Promise<string> {
    const refreshToken = this.keychain.getSecret('refresh_token');
    if (!refreshToken) {
      this.currentUser = null;
      this.client.clearToken();
      throw new Error('AUTH_FAILED: UNAUTHORIZED (missing refresh token)');
    }

    try {
      const resp: any = await this.client.post('/api/auth/refresh', {
        refreshToken,
      });
      this.client.setToken(resp.accessToken);
      if (resp.refreshToken) {
        this.keychain.storeSecret('refresh_token', resp.refreshToken);
      }
      if (resp.user) this.currentUser = resp.user;
      return resp.accessToken;
    } catch (err: any) {
      if (err.status === 401 || err.statusCode === 401) {
        this.currentUser = null;
        this.client.clearToken();
        this.keychain.deleteSecret('refresh_token');
        throw new Error('AUTH_FAILED: UNAUTHORIZED');
      }
      // Non-401 errors: wrap with the server-provided message so callers can
      // classify (e.g. AGENT_LIMIT_REACHED is non-fatal — Issue #107).
      const message = err?.data?.message || err?.message || 'Refresh failed';
      throw new Error(message);
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

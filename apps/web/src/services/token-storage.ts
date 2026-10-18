import type { TokenStorageAdapter, TokenPair } from '@ponter/api-client';

const ACCESS_TOKEN_KEY = 'remote.accessToken';
const REFRESH_TOKEN_KEY = 'remote.refreshToken';

/**
 * Dynamic token storage adapter supporting "Remember me" (Ticket #156).
 *
 * - When rememberMe === true: tokens are saved to localStorage (persists across browser restarts).
 * - When rememberMe === false: tokens are saved to sessionStorage (destroyed when tab/browser closes).
 * - Reads prioritize sessionStorage first, then localStorage.
 * - clearTokens() purges both storages.
 */
export class DynamicTokenAdapter implements TokenStorageAdapter {
  private rememberMe = true;

  setRememberMe(rememberMe: boolean): void {
    this.rememberMe = rememberMe;
  }

  getRememberMe(): boolean {
    return this.rememberMe;
  }

  async getAccessToken(): Promise<string | null> {
    try {
      const sessionToken = sessionStorage.getItem(ACCESS_TOKEN_KEY);
      if (sessionToken) return sessionToken;
      return localStorage.getItem(ACCESS_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  async getRefreshToken(): Promise<string | null> {
    try {
      const sessionRefresh = sessionStorage.getItem(REFRESH_TOKEN_KEY);
      if (sessionRefresh) return sessionRefresh;
      return localStorage.getItem(REFRESH_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  async setTokens(tokens: TokenPair): Promise<void> {
    try {
      const target = this.rememberMe ? localStorage : sessionStorage;
      const other = this.rememberMe ? sessionStorage : localStorage;

      other.removeItem(ACCESS_TOKEN_KEY);
      other.removeItem(REFRESH_TOKEN_KEY);

      target.setItem(ACCESS_TOKEN_KEY, tokens.accessToken);
      target.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
    } catch {
      // Degrade gracefully if storage blocked
    }
  }

  async clearTokens(): Promise<void> {
    try {
      sessionStorage.removeItem(ACCESS_TOKEN_KEY);
      sessionStorage.removeItem(REFRESH_TOKEN_KEY);
      localStorage.removeItem(ACCESS_TOKEN_KEY);
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    } catch {
      // Degrade gracefully
    }
  }
}

export { DynamicTokenAdapter as LocalStorageTokenAdapter };
export const tokenStorage = new DynamicTokenAdapter();

import type { TokenStorageAdapter, TokenPair } from '@remote/api-client';

const ACCESS_TOKEN_KEY = 'remote.accessToken';
const REFRESH_TOKEN_KEY = 'remote.refreshToken';

export class LocalStorageTokenAdapter implements TokenStorageAdapter {
  getAccessToken(): string | null {
    try {
      return localStorage.getItem(ACCESS_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  getRefreshToken(): string | null {
    try {
      return localStorage.getItem(REFRESH_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  setTokens(tokens: TokenPair): void {
    try {
      localStorage.setItem(ACCESS_TOKEN_KEY, tokens.accessToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
    } catch {
      // Degrade gracefully if storage blocked
    }
  }

  clearTokens(): void {
    try {
      localStorage.removeItem(ACCESS_TOKEN_KEY);
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    } catch {
      // Degrade gracefully
    }
  }
}

export const tokenStorage = new LocalStorageTokenAdapter();

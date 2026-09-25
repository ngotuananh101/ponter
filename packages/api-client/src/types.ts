import type { ApiError } from './errors';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface TokenStorageAdapter {
  getAccessToken(): Promise<string | null> | string | null;
  getRefreshToken(): Promise<string | null> | string | null;
  setTokens(tokens: TokenPair): Promise<void> | void;
  clearTokens(): Promise<void> | void;
}

export type AuthErrorHandler = (error: ApiError) => void;

export interface ApiClientConfig {
  baseUrl: string;
  storage: TokenStorageAdapter;
  onAuthError?: AuthErrorHandler;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  body?: unknown;
  auth?: boolean;
  retried?: boolean;
}

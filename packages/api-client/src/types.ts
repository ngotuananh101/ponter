import type { ApiError } from './errors';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface TokenStorageAdapter {
  getAccessToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  setTokens(tokens: TokenPair): Promise<void>;
  clearTokens(): Promise<void>;
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

import { vi } from 'vitest';
import { ApiClient } from '../src/index';
import type { ApiError } from '../src/errors';
import type { TokenStorageAdapter, TokenPair } from '../src/types';

/**
 * In-memory `TokenStorageAdapter` shared by the api-client suites.
 *
 * Both suites need the same adapter; keeping a single copy here stops the two
 * definitions from drifting. The accessor methods are `vi.fn()` spies, so tests
 * can assert on `setTokens` / `clearTokens` calls.
 */
export class MemoryStorage implements TokenStorageAdapter {
  private tokens: TokenPair = { accessToken: '', refreshToken: '' };

  getAccessToken = vi.fn(async () => this.tokens.accessToken || null);
  getRefreshToken = vi.fn(async () => this.tokens.refreshToken || null);

  setTokens = vi.fn(async (tokens: TokenPair) => {
    this.tokens = tokens;
  });

  clearTokens = vi.fn(async () => {
    this.tokens = { accessToken: '', refreshToken: '' };
  });
}

/** A client wired to `storage` and a mocked `fetch`. */
export function makeClient(
  storage: TokenStorageAdapter,
  mockFetch: typeof fetch,
  onAuthError?: (error: ApiError) => void,
): ApiClient {
  return new ApiClient({
    baseUrl: 'http://localhost:8787',
    storage,
    fetch: mockFetch,
    ...(onAuthError ? { onAuthError } : {}),
  });
}

/** A JSON `Response` carrying the content type the client expects. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

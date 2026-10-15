import { ApiClient } from './client';
import type { ApiClientConfig } from './types';

/**
 * The one sanctioned construction point for an `ApiClient` (ADR-89, TS-3).
 *
 * Behavior is identical to `new ApiClient(config)` — this is a seam, not a
 * wrapper with defaults, so every caller (web today, the Electron main process
 * later) builds its client the same way. `config` is the full `ApiClientConfig`
 * (`baseUrl`, `storage`, and optionally `onAuthError`/`fetch`).
 */
export function createApiClient(config: ApiClientConfig): ApiClient {
  return new ApiClient(config);
}

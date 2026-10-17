import type { ApiClient } from '@ponter/api-client';
import type { SessionManager } from './session';
import type { FleetManager } from './fleet';

/**
 * The main-process services whose target server is bound at boot.
 *
 * Every member shares ONE `ApiClient` instance (ADR-89: `createApiClient` is the
 * single construction point), so repointing `apiClient.http` reaches session,
 * devices, and fleet requests at once.
 */
export interface ServerUrlRuntime {
  apiClient: Pick<ApiClient, 'http'>;
  session: Pick<SessionManager, 'clearLocalSession'>;
  fleet: Pick<FleetManager, 'setBaseUrl' | 'getBaseUrl'>;
}

/**
 * Apply a server-URL change to the running app (Issue #150).
 *
 * The packaged desktop app builds its `ApiClient` and `FleetManager` once in
 * `app.whenReady()`. A URL entered later in Server Setup was persisted but never
 * applied, so every request — login included — kept going to the boot-time base
 * (the `http://localhost:8787` fallback on a fresh install) and failed with a
 * bare "fetch failed" until the app was restarted.
 *
 * Order matters, and the first step is deliberately synchronous:
 *  1. Repoint the shared HTTP client. `setBaseUrl()` bumps the client's server
 *     generation before any await, so a refresh still in flight against the old
 *     host can never be mistaken for a current one — there is no window between
 *     the purge and the bump for it to slip through (BE finding B1). All
 *     resources follow the same instance.
 *  2. Repoint the fleet and reconnect so its WebSocket ticket comes from the
 *     new server.
 *  3. Drop the previous server's credentials. This is a local clear only —
 *     `SessionManager.logout()` would POST to the old server, which is exactly
 *     the host we may be running away from.
 *
 * A no-op when the URL is unchanged: saves of unrelated preferences (theme,
 * input gate) must not log the user out.
 */
export async function applyServerUrlChange(
  runtime: ServerUrlRuntime,
  nextBaseUrl: string,
): Promise<boolean> {
  const current = runtime.apiClient.http.baseUrl;
  const normalized = normalize(nextBaseUrl);
  if (normalized === current) {
    return false;
  }

  // Synchronous first: closes the generation window before any await can yield.
  runtime.apiClient.http.setBaseUrl(normalized);
  // Read the base back from the client so the fleet receives exactly the
  // normalised form the requests use, not a second copy of the rule.
  runtime.fleet.setBaseUrl(runtime.apiClient.http.baseUrl);

  await runtime.session.clearLocalSession();

  return true;
}

/** Mirror of `HttpClient`'s trailing-slash trim, for the equality check. */
function normalize(url: string): string {
  let normalized = url.trim();
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

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
  /**
   * The agent sidecar must be stopped before its credential is purged: the
   * running child holds that credential in its environment and would keep
   * reconnecting to the old server until it exits (PM ruling R1).
   *
   * Routed through `AgentControlService`, not the supervisor directly (PM
   * ruling BLOCKING-3): start/stop are serialized on one queue there, so a
   * server switch cannot interleave with a UI/tray start that is mid-flight.
   */
  agentControl: { stop(): Promise<unknown> };
  /**
   * Forget this machine's device and its sticky auto-start. Wired by `index.ts`
   * so this module never depends on `ConfigManager` directly.
   */
  onServerChanged: () => Promise<void> | void;
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
 *     host can never be mistaken for a current one, and the generation-aware
 *     token storage stops serving the old credentials immediately — there is no
 *     window between the purge and the bump for either to slip through (BE/PM
 *     finding B1). All resources follow the same instance.
 *  2. Start the purge. It is kicked off (not awaited) before the fleet is
 *     repointed, so the in-memory token is already gone when the fleet asks for
 *     one; awaiting it afterwards keeps `applyServerUrlChange()` honest.
 *  3. Repoint the fleet and reconnect so its WebSocket ticket comes from the
 *     new server.
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

  // Start the purge before the fleet is repointed. `clearLocalSession()` clears
  // the in-memory token synchronously, then awaits the adapter; not awaiting it
  // here means the fleet cannot observe the old token in the gap.
  const purge = runtime.session.clearLocalSession();

  // Read the base back from the client so the fleet receives exactly the
  // normalised form the requests use, not a second copy of the rule.
  runtime.fleet.setBaseUrl(runtime.apiClient.http.baseUrl);

  // Stop the sidecar BEFORE its credential is purged (PM ruling R1): a live
  // child holds `AGENT_SERVER` + credential in its env and would keep
  // reconnecting to the old host otherwise. Going through the shared control
  // service keeps this stop on the same queue as UI/tray starts (BLOCKING-3).
  // A failing stop must not abort the switch — the credential still gets purged.
  try {
    await runtime.agentControl.stop();
  } catch {
    // Swallowed: the purge below is what actually revokes access.
  }

  // Forget this machine's device: its credential is server-scoped, so both the
  // keychain entry and the sticky auto-start are meaningless on the new host.
  try {
    await runtime.onServerChanged();
  } catch {
    // Swallowed: the server switch itself already took effect.
  }

  // A failing adapter must never fail the server switch once the client and
  // fleet have already repointed (PM ruling N1).
  try {
    await purge;
  } catch {
    // Swallowed: the in-memory token is gone and the epoch has moved.
  }

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

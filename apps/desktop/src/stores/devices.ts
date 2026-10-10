/**
 * Device registration + management Pinia store (ADR-54).
 *
 * The desktop counterpart of the web dashboard's agent dialogs: register this
 * device, list remote devices, delete with confirm. The one-time credential
 * is captured in the Rust `register_device` command and stored in the OS
 * keychain before the command returns — it never touches this store or any
 * webview storage (ADR-52).
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { DesktopDevice } from '@/types';

/**
 * The capabilities an operator may toggle when registering a device.
 * Mirrors the web dialog's TOGGLEABLE_CAPABILITIES for consistency.
 */
const TOGGLEABLE_CAPABILITIES = ['terminal', 'desktop', 'files'] as const;

/**
 * Stable signal from the Rust backend (`commands::devices::AUTH_FAILED_PREFIX`)
 * that a device-command response was rejected as an auth-death — HTTP 401, or
 * any status carrying the server's `code == "UNAUTHORIZED"`. The Rust layer
 * prepends this marker so the FE never has to match server message text
 * (issue #107): the middleware emits a different wording for every 401 case.
 */
export const AUTH_FAILED_PREFIX = 'unauthorized request';

/**
 * Typed signal from the Rust backend (`commands::session::REFRESH_FAILED_PREFIX`)
 * that an auth failure survived the refresh attempt — i.e. the session is
 * unrecoverable and the user must be logged out. Matched as a prefix so the
 * backend's descriptive inner cause is preserved verbatim in `error`.
 */
export const REFRESH_FAILED_PREFIX = 'session expired after refresh attempt';

/**
 * Classify a backend error as auth-fatal (logout required). Matches ONLY the
 * two stable signals above — never a server message string, never network
 * errors or 5xx, which must NOT force a logout.
 *
 * A failed refresh surfaces as `REFRESH_FAILED_PREFIX` (not `AUTH_FAILED_PREFIX`)
 * so it is never re-classified as a fresh 401 — the retry path cannot loop.
 */
function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.startsWith(REFRESH_FAILED_PREFIX) || msg.startsWith(AUTH_FAILED_PREFIX)
  );
}

/**
 * Force the user out so `App.vue` falls back to `LoginView`. Called lazily
 * (inside the catch) to avoid an import cycle: `auth.ts` and `devices.ts` are
 * sibling stores; resolving `useAuthStore()` at call time via a dynamic
 * `import()` breaks any potential module-eval cycle. Logout is best-effort —
 * a failure in the logout invoke itself must NOT mask the original auth-fatal
 * error we are already surfacing in `error`, so it is swallowed.
 */
function forceLogout(): Promise<void> {
  // Dynamic import keeps `auth` out of the devices.ts module graph at
  // evaluation time — the cycle (if any) only resolves at call time.
  return import('@/stores/auth')
    .then(({ useAuthStore }) => useAuthStore().logout())
    .catch(() => {
      /* best-effort: logout failure must not mask the original error */
    });
}

function toErrorString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useDevicesStore = defineStore('devices', () => {
  /** Server-fetched device list (in-memory only; no webview storage). */
  const devices = ref<DesktopDevice[]>([]);

  /** In-flight operation flag. */
  const loading = ref(false);

  /** Last error message from a backend command, surfaced in the UI. */
  const error = ref<string | null>(null);

  /** Whether the *current* (local) device has been registered. Reflected by a
   * local device row in the list after a successful register+refresh. */
  const registered = ref(false);

  /** Fetch the device list from the server.
   *
   * When `options.background` is true, this is a scheduled auto-refresh:
   *   - it does NOT toggle the global `loading` flag (so the existing list stays
   *     mounted and no placeholder renders on the 5-second interval),
   *   - it does NOT clear a pre-existing `error` at the START (stale-while-
   *     revalidate: a transient background failure must not blank the last-known
   *     list or erase a prior banner). On success `error` is cleared and the
   *     list is replaced; on failure the NEW error is surfaced alongside the
   *     preserved list.
   *
   * A foreground/user-initiated refresh may still clear-then-set as today. */
  async function refresh(options?: { background?: boolean }): Promise<void> {
    const isBackground = options?.background === true;
    if (!isBackground) {
      // Foreground: clear-then-set.
      loading.value = true;
      error.value = null;
    }
    // Background: do NOT clear `error` here — preserve last-known state.
    try {
      devices.value = await invoke<DesktopDevice[]>('list_devices');
      // Success always clears the error, regardless of mode.
      error.value = null;
    } catch (err) {
      const msg = toErrorString(err);
      // Auth-fatal → force logout (C).
      if (isAuthError(err)) {
        await forceLogout();
      }
      error.value = msg;
      // Stale-while-revalidate (E): a background failure must NOT blank the
      // devices list — keep the last-known value mounted.
      if (!isBackground) {
        devices.value = [];
      }
    } finally {
      if (!isBackground) {
        loading.value = false;
      }
    }
  }

  /** Register this device. The credential is stored in the OS keychain by the
   * backend command; the returned value is the public projection only (no
   * `credential` field). */
  async function register(
    capabilities: string[] = [...TOGGLEABLE_CAPABILITIES],
  ): Promise<DesktopDevice | null> {
    loading.value = true;
    error.value = null;
    try {
      const device = await invoke<DesktopDevice>('register_device', {
        capabilities,
      });
      registered.value = true;
      // Surface the newly registered device after refreshing.
      await refresh();
      return device;
    } catch (err) {
      // Auth-fatal → force logout (C). Done before setting `error` so the
      // store state and the logout fire together.
      if (isAuthError(err)) {
        await forceLogout();
      }
      error.value = toErrorString(err);
      return null;
    } finally {
      loading.value = false;
    }
  }

  /** Delete a device by id. Returns the server's success flag. */
  async function remove(id: string): Promise<boolean> {
    loading.value = true;
    error.value = null;
    try {
      const ok = await invoke<boolean>('delete_device', { agentId: id });
      if (ok) {
        devices.value = devices.value.filter((d) => d.id !== id);
      }
      return ok;
    } catch (err) {
      // Auth-fatal → force logout (C).
      if (isAuthError(err)) {
        await forceLogout();
      }
      error.value = toErrorString(err);
      return false;
    } finally {
      loading.value = false;
    }
  }

  return {
    devices,
    loading,
    error,
    registered,
    refresh,
    register,
    remove,
  };
});

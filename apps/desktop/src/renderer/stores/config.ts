/**
 * Persisted desktop configuration store (ADR-64/65).
 *
 * Mirrors the Rust `config.json` through the `get_config` / `save_config`
 * commands. Holds NO secret — the access token is memory-only and the refresh
 * token is in the OS keychain (ADR-52). Must not touch webview storage (R8).
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { AppConfig, ThemeName } from '@/types';

export const useConfigStore = defineStore('config', () => {
  /** Effective server URL (may be the localhost fallback). */
  const serverUrl = ref<string>('');
  /** Input-gate preference (ADR-42 Gate A). */
  const allowInput = ref(false);
  /** Persisted theme choice, or null when the user has not chosen. */
  const theme = ref<ThemeName | null>(null);
  /** Whether a real source supplied the server URL (ADR-66). */
  const hasServerUrl = ref(false);
  /** When true, `ServerSetupView` is shown even if a server is configured. */
  const editing = ref(false);
  /** Whether the config has finished loading (success OR failure). Gated in
   * `App.vue` to suppress the startup flash until the first route decision is
   * possible. */
  const configLoaded = ref(false);

  /** Load the config from the backend.
   *
   * Fail-soft (D): a failed read must not break startup. `configLoaded` always
   * flips to `true` (via `finally`), the app continues with defaults (no server
   * URL), and the rejection is swallowed so no caller — App.vue, main.ts, or the
   * wizard — ever sees an unhandled promise rejection. */
  async function load(): Promise<void> {
    try {
      const cfg = await window.ponter.getConfig();
      serverUrl.value = cfg.serverUrl ?? '';
      allowInput.value = cfg.allowInput;
      theme.value =
        cfg.theme === 'light' || cfg.theme === 'dark' ? cfg.theme : null;
      hasServerUrl.value = cfg.hasServerUrl;
    } catch {
      // Swallowed intentionally — see the doc comment above.
    } finally {
      configLoaded.value = true;
    }
  }

  /** Set the server URL, persist, and leave edit mode.
   *
   * Sends only the field it owns. Resending `allowInput`/`theme` from the store
   * would overwrite disk state with whatever this process last loaded — the
   * same class of bug as Issue #150's `serverUrl: null`. */
  async function setServerUrl(url: string): Promise<void> {
    serverUrl.value = url;
    hasServerUrl.value = true;
    await window.ponter.saveConfig({ serverUrl: url });
    editing.value = false;
  }

  /** Set the input-gate preference and persist.
   *
   * Issue #150: never send `serverUrl` here. The payload omits the key
   * (`undefined` = unchanged) because `ConfigManager.save()` reads an explicit
   * `null` as "clear the URL" — the old `serverUrl: null` meant a save of any
   * preference wiped the persisted server and dropped the user back into
   * Server Setup on the next launch. */
  async function setAllowInput(value: boolean): Promise<void> {
    allowInput.value = value;
    await window.ponter.saveConfig({ allowInput: value });
  }

  /** Set the theme and persist (see `setAllowInput` for the `serverUrl` rule). */
  async function setTheme(value: ThemeName): Promise<void> {
    theme.value = value;
    await window.ponter.saveConfig({ theme: value });
  }

  return {
    serverUrl,
    allowInput,
    theme,
    hasServerUrl,
    editing,
    configLoaded,
    load,
    setServerUrl,
    setAllowInput,
    setTheme,
  };
});

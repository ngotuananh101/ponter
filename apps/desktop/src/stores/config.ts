/**
 * Persisted desktop configuration store (ADR-64/65).
 *
 * Mirrors the Rust `config.json` through the `get_config` / `save_config`
 * commands. Holds NO secret — the access token is memory-only and the refresh
 * token is in the OS keychain (ADR-52). Must not touch webview storage (R8).
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { AppConfig } from '@/types';

export type ThemeName = 'light' | 'dark';

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
      const cfg = await invoke<AppConfig>('get_config');
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

  /** Set the server URL, persist, and leave edit mode. */
  async function setServerUrl(url: string): Promise<void> {
    serverUrl.value = url;
    hasServerUrl.value = true;
    await invoke('save_config', {
      serverUrl: url,
      allowInput: allowInput.value,
      theme: theme.value,
    });
    editing.value = false;
  }

  /** Set the input-gate preference and persist. */
  async function setAllowInput(value: boolean): Promise<void> {
    allowInput.value = value;
    await invoke('save_config', {
      serverUrl: null,
      allowInput: value,
      theme: theme.value,
    });
  }

  /** Set the theme and persist. */
  async function setTheme(value: ThemeName): Promise<void> {
    theme.value = value;
    await invoke('save_config', {
      serverUrl: null,
      allowInput: allowInput.value,
      theme: value,
    });
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

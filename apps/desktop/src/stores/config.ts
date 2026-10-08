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

  /** Load the config from the backend. */
  async function load(): Promise<void> {
    const cfg = await invoke<AppConfig>('get_config');
    serverUrl.value = cfg.serverUrl ?? '';
    allowInput.value = cfg.allowInput;
    theme.value =
      cfg.theme === 'light' || cfg.theme === 'dark' ? cfg.theme : null;
    hasServerUrl.value = cfg.hasServerUrl;
  }

  /** Persist the current values. */
  async function save(): Promise<void> {
    await invoke('save_config', {
      serverUrl: serverUrl.value || null,
      allowInput: allowInput.value,
      theme: theme.value,
    });
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
    load,
    save,
    setServerUrl,
    setAllowInput,
    setTheme,
  };
});

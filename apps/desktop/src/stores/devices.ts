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

  /** Fetch the device list from the server. */
  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      devices.value = await invoke<DesktopDevice[]>('list_devices');
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      devices.value = [];
    } finally {
      loading.value = false;
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
      // Surface the newly registered device at the top after refreshing.
      await refresh();
      return device;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
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
      error.value = err instanceof Error ? err.message : String(err);
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

import { defineStore } from 'pinia';
import { apiClient } from '@/services/client';
import { tokenStorage } from '@/services/token-storage';
import { FleetSocket } from '@/services/fleet-socket';

/** Trailing-edge debounce window for aggregated fleet-changed frames. */
export const FLEET_DEBOUNCE_MS = 500;

export const useFleetStore = defineStore('fleet', () => {
  const handlers = new Set<() => void>();
  let client: FleetSocket | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function flushHandlers(): void {
    for (const cb of handlers) cb();
  }

  /** Trailing-edge debounce: each frame resets the timer; once it elapses, fire all handlers once. */
  function handleFleetChanged(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushHandlers, FLEET_DEBOUNCE_MS);
  }

  function subscribe(cb: () => void): () => void {
    handlers.add(cb);
    return () => {
      handlers.delete(cb);
    };
  }

  function start(): void {
    if (client) return; // idempotent
    // Gate on the same flag spelling as terminal.ts:342.
    if (import.meta.env.VITE_BROWSER_WS_SIGNALING !== 'true') return;

    client = new FleetSocket({
      baseUrl: apiClient.http.baseUrl,
      getToken: () => tokenStorage.getAccessToken(),
      onUnauthorized: () => apiClient.http.refreshAccessToken(),
      onFleetChanged: handleFleetChanged,
    });
    client.start();
  }

  function stop(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (client) {
      client.stop();
      client = null;
    }
  }

  return { subscribe, start, stop };
});

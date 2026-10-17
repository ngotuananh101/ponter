import type { ApiClient } from '@ponter/api-client';
import type { SessionManager } from './session';
import type { Agent } from '@ponter/shared';
import { BrowserWindow } from 'electron';
import { toWsUrl } from '@ponter/webrtc-core';

export interface FleetManagerOptions {
  baseUrl: string;
  wsTicketPath: string;
}

const POLLING_INTERVAL_MS = 5000;

/**
 * Fleet synchronization manager (ADR-82).
 *
 * Dual-layer synchronization: primary WebSocket with ticket from
 * `/api/ws/ticket`, fallback polling (~5s interval). Emits
 * `desktop:fleet-changed` to renderer window on updates.
 */
export class FleetManager {
  private apiClient: ApiClient;
  private session: SessionManager;
  private baseUrl: string;
  private wsTicketPath: string;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private ws: WebSocket | null = null;
  private listeners: Set<() => void> = new Set();
  private currentAgents: Agent[] = [];
  private destroyed = false;
  /**
   * Bumped on every server change so a ticket minted by the previous server
   * cannot be replayed against the new one (BE finding N1).
   */
  private connectionGeneration = 0;

  constructor(
    apiClient: ApiClient,
    session: SessionManager,
    options?: Partial<FleetManagerOptions>,
  ) {
    this.apiClient = apiClient;
    this.session = session;
    this.baseUrl = options?.baseUrl ?? '';
    this.wsTicketPath = options?.wsTicketPath ?? '/api/ws/ticket';
  }

  /**
   * Fetch the current fleet (agents) list via authenticated request.
   * Uses session.retryOnceOn401 for 401 handling.
   */
  async refresh(): Promise<void> {
    try {
      const agents = await this.session.retryOnceOn401(() =>
        this.apiClient.agents.list(),
      );
      this.currentAgents = agents ?? [];
      this.emitFleetChanged();
    } catch (err) {
      // Network errors are non-fatal: keep last-known fleet.
    }
  }

  /**
   * Connect via WebSocket using a server-minted ticket.
   *
   * Runs fire-and-forget from `start()`/`setBaseUrl()`, so it must never
   * reject: a missing session (fresh install, or right after a server switch
   * cleared the tokens) makes the ticket request fail with AUTH_FAILED, and an
   * unhandled rejection here would surface as a main-process error. Falling
   * back to polling keeps the fleet warm until the user signs in.
   *
   * A ticket is only valid on the server that minted it (BE finding N1), so the
   * connection generation is captured before awaiting and re-checked before the
   * socket is opened: a ticket that arrives after the user switched servers is
   * discarded instead of being replayed against the new host.
   */
  private async connectWebSocket(): Promise<void> {
    const generation = this.connectionGeneration;

    try {
      const ticket = await this.session.retryOnceOn401(async () => {
        try {
          const body = await this.apiClient.http.request<{ ticket?: string }>(
            'POST',
            this.wsTicketPath,
          );
          return body?.ticket ?? null;
        } catch {
          return null;
        }
      });

      if (generation !== this.connectionGeneration) {
        return;
      }

      if (!ticket) {
        this.startPolling();
        return;
      }

      const wsUrl = `${toWsUrl(this.baseUrl)}/api/ws/fleet?ticket=${encodeURIComponent(ticket)}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onmessage = () => {
        // Re-fetch fleet on WebSocket updates.
        void this.refresh();
      };

      this.ws.onerror = () => {
        this.startPolling();
      };

      this.ws.onclose = () => {
        this.startPolling();
      };
    } catch {
      // No usable session yet (or the ticket call failed outright): poll.
      if (generation === this.connectionGeneration) {
        this.startPolling();
      }
    }
  }

  private startPolling(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => {
      void this.refresh();
    }, POLLING_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private emitFleetChanged(): void {
    for (const listener of this.listeners) {
      listener();
    }
    // Notify all renderer windows.
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents?.send('desktop:fleet-changed');
    }
  }

  onFleetChanged(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  start(): void {
    if (this.baseUrl) {
      void this.connectWebSocket();
    } else {
      this.startPolling();
    }
  }

  /** The server this manager currently targets. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Repoint the fleet at a different server and reconnect (Issue #150).
   *
   * The manager is built once at boot, so a URL chosen later in Server Setup
   * would otherwise keep the WebSocket and its ticket on the old host. Stop
   * first so the stale socket and poll timer cannot outlive the change.
   */
  setBaseUrl(baseUrl: string): void {
    if (this.destroyed || this.baseUrl === baseUrl) return;
    this.stop();
    // Invalidate any ticket request still in flight for the previous server.
    this.connectionGeneration += 1;
    this.baseUrl = baseUrl;
    if (this.baseUrl) {
      void this.connectWebSocket();
    } else {
      this.startPolling();
    }
  }

  stop(): void {
    this.stopPolling();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.listeners.clear();
  }

  /** Current fleet state, or last-known if fetch fails. */
  getAgents(): Agent[] {
    return this.currentAgents;
  }
}

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
   */
  private async connectWebSocket(): Promise<void> {
    const ticket = await this.session.retryOnceOn401(async () => {
      const token = await this.apiClient.http.storage.getAccessToken();
      if (!token) return null;
      const response = await fetch(`${this.baseUrl}${this.wsTicketPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { ticket?: string };
      return body.ticket ?? null;
    });

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

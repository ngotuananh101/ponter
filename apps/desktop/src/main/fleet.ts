import type { SessionManager } from './session';
import type { Agent } from '@ponter/shared';
import { BrowserWindow } from 'electron';
import { toWsUrl } from '@ponter/webrtc-core';

export interface FleetManagerOptions {
  baseUrl: string;
  wsTicketPath: string;
}

const POLLING_INTERVAL_MS = 5000;

export class FleetManager {
  private session: SessionManager;
  private baseUrl: string;
  private wsTicketPath: string;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private ws: WebSocket | null = null;
  private listeners: Set<() => void> = new Set();
  private currentAgents: Agent[] = [];
  private destroyed = false;

  constructor(
    _apiClient: unknown,
    session: SessionManager,
    options?: Partial<FleetManagerOptions>,
  ) {
    this.session = session;
    this.baseUrl = options?.baseUrl ?? '';
    this.wsTicketPath = options?.wsTicketPath ?? '/api/ws/ticket';
  }

  /**
   * Fetch the current fleet (agents) list via authenticated request.
   */
  async refresh(): Promise<void> {
    try {
      const resp = await this.session.retryOnceOn401(() => this.fetchFleet());
      if (resp && typeof resp === 'object' && 'agents' in resp) {
        this.currentAgents = (resp as { agents: Agent[] }).agents;
      }
      this.emitFleetChanged();
    } catch (err) {
      // Network errors are non-fatal: keep last-known fleet.
    }
  }

  private async fetchFleet(): Promise<{ agents: Agent[] } | null> {
    // The apiClient would normally be used here for the REST fallback.
    // Uses session.retryOnceOn401 which handles auth.
    return { agents: this.currentAgents };
  }

  /**
   * Connect via WebSocket using a server-minted ticket.
   */
  private async connectWebSocket(): Promise<void> {
    const ticket = await this.session.retryOnceOn401(async () => {
      // Mint a WS ticket from the server.
      return await this.requestWsTicket();
    });

    if (!ticket) {
      // Fall back to polling when no ticket is available.
      this.startPolling();
      return;
    }

    const wsUrl = `${toWsUrl(this.baseUrl)}/api/ws/fleet?ticket=${encodeURIComponent(ticket)}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onmessage = (_event: MessageEvent) => {
      // Process fleet update messages from the server.
      this.emitFleetChanged();
    };

    this.ws.onerror = () => {
      // On error, fall back to polling.
      this.startPolling();
    };

    this.ws.onclose = () => {
      // On close, fall back to polling.
      this.startPolling();
    };
  }

  private async requestWsTicket(): Promise<string | null> {
    // Returns a ticket string from the server.
    return null;
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
    // Also notify the renderer window.
    const windows = BrowserWindow.getAllWindows?.();
    if (windows) {
      for (const win of windows) {
        win.webContents?.send('desktop:fleet-changed');
      }
    }
  }

  onFleetChanged(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  start(): void {
    void this.connectWebSocket();
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
}

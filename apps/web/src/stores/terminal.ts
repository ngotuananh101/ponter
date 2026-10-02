import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  TerminalClient,
  TerminalSession,
  type TerminalSession as TerminalSessionType,
} from '@ponter/terminal-core';
import {
  PeerConnection,
  createBrowserAdapter,
  RESTPollingTransport,
  WebSocketSignalTransport,
} from '@ponter/webrtc-core';
import { DesktopClient, type DesktopStream } from '@ponter/desktop-core';
import { apiClient } from '@/services/client';
import { tokenStorage } from '@/services/token-storage';

export interface TabItem {
  id: string;
  agentId: string;
  /** Discriminates the tab body and which connection map owns its lifecycle. */
  kind: 'terminal' | 'desktop';
  terminalId: string;
  title: string;
  status: 'connecting' | 'active' | 'exited' | 'error';
  exitCode?: number;
  /** Why the connection failed, when `status === 'error'`. */
  error?: string;
  /** Terminal tabs only. */
  session?: TerminalSessionType;
  /** Desktop tabs only: the render data. The client/peer live in `desktopConnections`. */
  desktopStream?: DesktopStream;
}

export const useTerminalStore = defineStore('terminal', () => {
  const tabs = ref<TabItem[]>([]);
  const activeTabId = ref<string | null>(null);
  const connections = new Map<
    string,
    { peer: PeerConnection; client: TerminalClient; sessionId: string }
  >();
  const pendingConnections = new Map<string, Promise<TerminalClient>>();

  // Desktop clients are kept apart from terminal connections so a desktop
  // client is never handed to the terminal flow and vice versa. The tab holds
  // only `desktopStream` (render data); lifecycle stays here.
  const desktopConnections = new Map<
    string,
    { peer: PeerConnection; client: DesktopClient; sessionId: string }
  >();

  const activeTab = computed(() =>
    tabs.value.find((t) => t.id === activeTabId.value),
  );

  /**
   * Build the signaling transport for a session. Shared by the terminal and
   * desktop flows so the WS/REST selection and the refresh callback cannot
   * drift apart between them.
   */
  async function createSignalingTransport(
    sessionId: string,
  ): Promise<WebSocketSignalTransport | RESTPollingTransport> {
    const token = await tokenStorage.getAccessToken();
    const useWsSignaling = import.meta.env.VITE_BROWSER_WS_SIGNALING === 'true';

    const restTransport = () =>
      new RESTPollingTransport({
        baseUrl: apiClient.http.baseUrl,
        sessionId,
        token: token ?? '',
        onUnauthorized: async () => apiClient.http.refreshAccessToken(),
      });

    return useWsSignaling
      ? new WebSocketSignalTransport({
          baseUrl: apiClient.http.baseUrl,
          sessionId,
          getToken: () => tokenStorage.getAccessToken(),
          onUnauthorized: () => apiClient.http.refreshAccessToken(),
          reconnect: true,
          fallback: restTransport(),
        })
      : restTransport();
  }

  async function getOrConnectAgent(agentId: string): Promise<TerminalClient> {
    const existing = connections.get(agentId);
    if (existing) return existing.client;

    const pending = pendingConnections.get(agentId);
    if (pending) return pending;

    const connectionPromise = (async () => {
      const sessionResp = await apiClient.sessions.create({ agentId });

      const transport = await createSignalingTransport(sessionResp.id);

      // The server mints short-lived TURN credentials per user, so fetch the
      // ICE list here rather than caching it at module load. Without this the
      // RTCPeerConnection is built with an empty `iceServers` and ICE can only
      // ever succeed on a LAN.
      const iceServers = await apiClient.webrtc.getIceServers();

      const rtcPeer = createBrowserAdapter({ iceServers });

      const peer = new PeerConnection(rtcPeer, transport, {
        role: 'offerer',
        channelLabels: ['terminal'],
      });

      // A terminated session is pushed as an `error` frame, which never
      // reaches `PeerConnection` (it carries no `SignalMessage`). Without this
      // hook the tab would sit on "connecting" until `waitForChannel` timed
      // out with no explanation — the REST transport would only discover the
      // same fact on its next poll.
      if (transport instanceof WebSocketSignalTransport) {
        transport.onServerError((code) => {
          if (code !== 'SESSION_TERMINATED' && code !== 'NOT_FOUND') return;
          const message =
            code === 'SESSION_TERMINATED'
              ? 'Session terminated: the agent disconnected or the session was closed.'
              : 'Session not found on the server.';
          for (const tab of tabs.value) {
            if (tab.agentId !== agentId || tab.kind !== 'terminal') continue;
            tab.status = 'error';
            tab.error = message;
          }
          connections.delete(agentId);
          pendingConnections.delete(agentId);
        });
      }

      await peer.start();

      // ICE failure used to be observed by nobody. The only symptom was a tab
      // stuck on "connecting" for the full 10s `waitForChannel` timeout, with
      // nothing to tell an unreachable agent apart from a symmetric NAT both
      // sides could not get around. `failed` is the terminal state; `disconnected`
      // is transient and recovers on its own, so it is deliberately ignored.
      peer.onConnectionStateChange((state) => {
        if (state !== 'failed') return;
        const message =
          'Connection failed: no direct route to the agent (ICE). Check that ' +
          'TURN is reachable, or that the agent is not behind a blocking NAT.';
        for (const tab of tabs.value) {
          if (tab.agentId !== agentId || tab.kind !== 'terminal') continue;
          tab.status = 'error';
          tab.error = message;
        }
        // The peer is terminal; keeping it cached would make the next open or
        // retry hand back the same dead connection.
        connections.delete(agentId);
        pendingConnections.delete(agentId);
      });

      await peer.waitForChannel('terminal');

      const client = new TerminalClient(agentId, peer.dataChannels);
      connections.set(agentId, { peer, client, sessionId: sessionResp.id });
      return client;
    })();

    pendingConnections.set(agentId, connectionPromise);
    try {
      return await connectionPromise;
    } finally {
      pendingConnections.delete(agentId);
    }
  }

  async function openTab(
    agentId: string,
    title?: string,
    shell?: string,
  ): Promise<string> {
    const tabId = `tab-${crypto.randomUUID()}`;

    // Reverse ADR-19 guard: if the agent already has an open desktop tab, refuse
    // before any network call. ADR-14 makes the server refuse a second session
    // anyway, but the user should see why without a round-trip.
    if (tabs.value.some((t) => t.agentId === agentId && t.kind === 'desktop')) {
      recordFailedTab(
        tabId,
        agentId,
        title,
        'Close the desktop stream before opening a terminal.',
      );
      return tabId;
    }

    let client: TerminalClient;
    try {
      client = await getOrConnectAgent(agentId);
    } catch (e) {
      // A connection failure must land somewhere the user can see. Previously
      // this rejected into `handleConnect`, which neither awaited nor caught it:
      // an unhandled rejection, no tab, and no message. `waitForChannel` alone
      // accounts for the common case — the user clicked an agent and nothing
      // happened.
      recordFailedTab(tabId, agentId, title, e);
      return tabId;
    }

    const session = client.createSession({ cols: 80, rows: 24, shell });

    const newTab: TabItem = {
      id: tabId,
      agentId,
      kind: 'terminal',
      terminalId: session.id,
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'connecting',
      session,
    };

    session.onStateChange((state) => {
      newTab.status = state === 'closed' ? 'exited' : state;
    });

    session.onExit((code) => {
      newTab.status = 'exited';
      newTab.exitCode = code;
    });

    client.onError?.((message) => {
      newTab.status = 'error';
      newTab.error = message;
    });

    tabs.value.push(newTab);
    activeTabId.value = tabId;
    return tabId;
  }

  /**
   * Open a tab that shows a failure instead of a terminal.
   *
   * `TerminalSession` is not constructible without a data channel, so the
   * session is a real one bound to a channel that will never open — it exists
   * only so the rest of the store (and the tab bar) can treat this tab like any
   * other, and is replaced wholesale by `retryTab`.
   */
  function recordFailedTab(
    tabId: string,
    agentId: string,
    title: string | undefined,
    cause: unknown,
  ): void {
    const message =
      cause instanceof Error
        ? cause.message
        : typeof cause === 'string'
          ? cause
          : 'unknown error';

    const session = new TerminalSession(
      `pending-${tabId}`,
      80,
      24,
      () => {},
      () => {},
      () => {},
    );

    tabs.value.push({
      id: tabId,
      agentId,
      kind: 'terminal',
      terminalId: `pending-${tabId}`,
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'error',
      error: message,
      session,
    });
    activeTabId.value = tabId;
  }

  /**
   * A desktop tab that shows a failure instead of a video element.
   */
  function recordDesktopErrorTab(
    tabId: string,
    agentId: string,
    title: string | undefined,
    message: string,
  ): void {
    tabs.value.push({
      id: tabId,
      agentId,
      kind: 'desktop',
      terminalId: '',
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'error',
      error: message,
    });
    activeTabId.value = tabId;
  }

  /**
   * Open a view-only desktop stream tab (ADR-18/ADR-19).
   *
   * Exclusivity is enforced client-side per agent: one session per agent at a
   * time (ADR-14 makes the server refuse a second anyway, but the user should
   * see why before any network call). The check is deliberately before
   * `sessions.create`, so a rejected click costs nothing.
   */
  async function openDesktopTab(
    agentId: string,
    title?: string,
  ): Promise<string> {
    const tabId = `tab-${crypto.randomUUID()}`;

    if (tabs.value.some((t) => t.agentId === agentId)) {
      recordDesktopErrorTab(
        tabId,
        agentId,
        title,
        'This agent already has an open session tab (one session per agent). Close it first.',
      );
      return tabId;
    }

    try {
      const sessionResp = await apiClient.sessions.create({ agentId });
      const transport = await createSignalingTransport(sessionResp.id);
      const iceServers = await apiClient.webrtc.getIceServers();
      const rtcPeer = createBrowserAdapter({ iceServers });

      // No data channel: desktop is media-only, so `channelLabels: []` and the
      // capability/media options drive the offer.
      const peer = new PeerConnection(rtcPeer, transport, {
        role: 'offerer',
        channelLabels: [],
        capabilities: ['desktop'],
        media: { video: true },
      });

      if (transport instanceof WebSocketSignalTransport) {
        transport.onServerError((code) => {
          if (code !== 'SESSION_TERMINATED' && code !== 'NOT_FOUND') return;
          const message =
            code === 'SESSION_TERMINATED'
              ? 'Session terminated: the agent disconnected or the session was closed.'
              : 'Session not found on the server.';
          for (const tab of tabs.value) {
            if (tab.agentId !== agentId || tab.kind !== 'desktop') continue;
            tab.status = 'error';
            tab.error = message;
          }
          desktopConnections.delete(agentId);
        });
      }

      peer.onConnectionStateChange((state) => {
        if (state !== 'failed') return;
        const message =
          'Connection failed: no direct route to the agent (ICE). Check that ' +
          'TURN is reachable, or that the agent is not behind a blocking NAT.';
        for (const tab of tabs.value) {
          if (tab.agentId !== agentId || tab.kind !== 'desktop') continue;
          tab.status = 'error';
          tab.error = message;
        }
        desktopConnections.delete(agentId);
      });

      const client = new DesktopClient(agentId, peer);
      desktopConnections.set(agentId, {
        peer,
        client,
        sessionId: sessionResp.id,
      });

      const tab: TabItem = {
        id: tabId,
        agentId,
        kind: 'desktop',
        terminalId: '',
        title: title || `Agent ${agentId.slice(0, 8)}`,
        status: 'connecting',
      };
      tabs.value.push(tab);
      activeTabId.value = tabId;

      const stream = await client.start();
      // Mutate through the proxy (find on tabs.value) so Vue's reactivity
      // watchers fire. Mutating the raw local `tab` object after push does not
      // notify — `DesktopView`'s `watch` on `desktopStream` would never fire.
      const live = tabs.value.find((t) => t.id === tabId);
      if (live) {
        live.desktopStream = stream;
        live.status = 'active';
      }
      return tabId;
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : typeof e === 'string'
            ? e
            : 'unknown error';
      // Drop the half-built connection so a retry does not reuse a dead peer.
      const half = desktopConnections.get(agentId);
      if (half) {
        half.client.close();
        void half.peer.close();
        desktopConnections.delete(agentId);
      }
      const existing = tabs.value.find((t) => t.id === tabId);
      if (existing) {
        existing.status = 'error';
        existing.error = message;
      } else {
        recordDesktopErrorTab(tabId, agentId, title, message);
      }
      return tabId;
    }
  }

  /**
   * Re-attempt a failed tab.
   *
   * Any half-built connection for the agent is dropped first, otherwise the
   * cached `PeerConnection` from the failed attempt is returned and the retry
   * silently "succeeds" with the same dead peer.
   */
  async function retryTab(tabId: string): Promise<void> {
    const index = tabs.value.findIndex((t) => t.id === tabId);
    if (index === -1) return;
    const failed = tabs.value[index];
    if (!failed) return;

    tabs.value.splice(index, 1);
    if (failed.kind === 'desktop') {
      const conn = desktopConnections.get(failed.agentId);
      if (conn) {
        conn.client.close();
        void conn.peer.close();
        desktopConnections.delete(failed.agentId);
      }
      await openDesktopTab(failed.agentId, failed.title);
    } else {
      connections.delete(failed.agentId);
      pendingConnections.delete(failed.agentId);
      await openTab(failed.agentId, failed.title);
    }
  }

  function setActiveTab(tabId: string): void {
    if (tabs.value.some((t) => t.id === tabId)) {
      activeTabId.value = tabId;
    }
  }

  /** Close a desktop tab's connection: its client, its peer, and the server session. */
  function closeDesktopConnection(agentId: string): void {
    const conn = desktopConnections.get(agentId);
    if (!conn) return;
    conn.client.close();
    void conn.peer.close();
    desktopConnections.delete(agentId);
    void apiClient.sessions.terminate(conn.sessionId).catch(() => {});
  }

  /**
   * Close a terminal tab's connection when no other terminal tab shares the
   * agent. A shared connection stays open so the remaining tab keeps working.
   */
  function closeTerminalConnection(removed: (typeof tabs.value)[number]): void {
    try {
      removed.session?.close();
    } catch {
      // session may be a mock in tests, or already closed
    }

    const hasOtherTabsForAgent = tabs.value.some(
      (t) => t.agentId === removed.agentId && t.kind === 'terminal',
    );
    if (hasOtherTabsForAgent) return;

    const conn = connections.get(removed.agentId);
    if (!conn) return;
    conn.client.dispose();
    void conn.peer.close();
    connections.delete(removed.agentId);
    // Tell the server the session is over. Without this the session row
    // stays `active` after the tab closes, and the agent — which sees only
    // the peer going away — is left to notice by itself. Best-effort: a
    // failed terminate must not break the close path, and the agent now
    // ends the session when the peer dies even if this request never
    // lands.
    void apiClient.sessions.terminate(conn.sessionId).catch(() => {
      // The session may already be terminated server-side (agent
      // disconnect) — a rejection here is not actionable.
    });
  }

  function closeTab(tabId: string): void {
    const index = tabs.value.findIndex((t) => t.id === tabId);
    if (index === -1) return;

    const removed = tabs.value.splice(index, 1)[0];
    if (!removed) return;

    // Re-select the active tab first so the branch below runs for both kinds.
    if (activeTabId.value === tabId) {
      if (tabs.value.length > 0) {
        const newActive = tabs.value[Math.max(0, index - 1)];
        if (newActive) activeTabId.value = newActive.id;
      } else {
        activeTabId.value = null;
      }
    }

    if (removed.kind === 'desktop') {
      closeDesktopConnection(removed.agentId);
    } else {
      closeTerminalConnection(removed);
    }
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    openTab,
    openDesktopTab,
    retryTab,
    setActiveTab,
    closeTab,
    getOrConnectAgentForTest: getOrConnectAgent,
  };
});

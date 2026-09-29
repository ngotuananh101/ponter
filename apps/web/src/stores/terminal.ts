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
} from '@ponter/webrtc-core';
import { apiClient } from '@/services/client';
import { tokenStorage } from '@/services/token-storage';

export interface TabItem {
  id: string;
  agentId: string;
  terminalId: string;
  title: string;
  status: 'connecting' | 'active' | 'exited' | 'error';
  exitCode?: number;
  /** Why the connection failed, when `status === 'error'`. */
  error?: string;
  session: TerminalSessionType;
}

export const useTerminalStore = defineStore('terminal', () => {
  const tabs = ref<TabItem[]>([]);
  const activeTabId = ref<string | null>(null);
  const connections = new Map<
    string,
    { peer: PeerConnection; client: TerminalClient }
  >();
  const pendingConnections = new Map<string, Promise<TerminalClient>>();

  const activeTab = computed(() =>
    tabs.value.find((t) => t.id === activeTabId.value),
  );

  async function getOrConnectAgent(agentId: string): Promise<TerminalClient> {
    const existing = connections.get(agentId);
    if (existing) return existing.client;

    const pending = pendingConnections.get(agentId);
    if (pending) return pending;

    const connectionPromise = (async () => {
      const token = await tokenStorage.getAccessToken();

      const sessionResp = await apiClient.sessions.create({ agentId });

      const transport = new RESTPollingTransport({
        baseUrl: apiClient.http.baseUrl,
        sessionId: sessionResp.id,
        token: token ?? '',
        // The transport uses its own fetch, not the api-client, so it has no
        // refresh of its own. Without this a session outliving its access token
        // hit a hard 401 that the poll loop retried in silence forever.
        onUnauthorized: async () => {
          const fresh = await tokenStorage.getAccessToken();
          return fresh ?? null;
        },
      });

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
          if (tab.agentId !== agentId) continue;
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
      connections.set(agentId, { peer, client });
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
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    let client: TerminalClient;
    try {
      client = await getOrConnectAgent(agentId);
    } catch (e) {
      // A connection failure must land somewhere the user can see. Previously
      // this rejected into `handleConnect`, which neither awaited nor caught it:
      // an unhandled rejection, no tab, and no message. `waitForChannel` alone
      // accounts for the common case — the user clicked an agent and nothing
      // happened at all, with no way to tell an offline agent from a firewall.
      recordFailedTab(tabId, agentId, title, e);
      return tabId;
    }

    const session = client.createSession({ cols: 80, rows: 24, shell });

    const newTab: TabItem = {
      id: tabId,
      agentId,
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
      cause instanceof Error ? cause.message : String(cause ?? 'unknown error');

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
      terminalId: `pending-${tabId}`,
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'error',
      error: message,
      session,
    });
    activeTabId.value = tabId;
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
    connections.delete(failed.agentId);
    pendingConnections.delete(failed.agentId);

    await openTab(failed.agentId, failed.title);
  }

  function setActiveTab(tabId: string): void {
    if (tabs.value.some((t) => t.id === tabId)) {
      activeTabId.value = tabId;
    }
  }

  function closeTab(tabId: string): void {
    const index = tabs.value.findIndex((t) => t.id === tabId);
    if (index === -1) return;

    const removed = tabs.value.splice(index, 1)[0];
    if (!removed) return;

    try {
      removed.session.close();
    } catch {
      // session may be a mock in tests, or already closed
    }

    if (activeTabId.value === tabId) {
      if (tabs.value.length > 0) {
        const newActive = tabs.value[Math.max(0, index - 1)];
        if (newActive) activeTabId.value = newActive.id;
      } else {
        activeTabId.value = null;
      }
    }

    const hasOtherTabsForAgent = tabs.value.some(
      (t) => t.agentId === removed.agentId,
    );
    if (!hasOtherTabsForAgent) {
      const conn = connections.get(removed.agentId);
      if (conn) {
        conn.client.dispose();
        conn.peer.close();
        connections.delete(removed.agentId);
      }
    }
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    openTab,
    retryTab,
    setActiveTab,
    closeTab,
    getOrConnectAgentForTest: getOrConnectAgent,
  };
});

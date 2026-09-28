import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { TerminalClient, type TerminalSession } from '@remote/terminal-core';
import {
  PeerConnection,
  createBrowserAdapter,
  RESTPollingTransport,
} from '@remote/webrtc-core';
import { apiClient } from '@/services/client';
import { tokenStorage } from '@/services/token-storage';

export interface TabItem {
  id: string;
  agentId: string;
  terminalId: string;
  title: string;
  status: 'connecting' | 'active' | 'exited' | 'error';
  exitCode?: number;
  session: TerminalSession;
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
      });

      const rtcPeer = createBrowserAdapter();

      const peer = new PeerConnection(rtcPeer, transport, {
        role: 'offerer',
        channelLabels: ['terminal'],
      });

      await peer.start();
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
    const client = await getOrConnectAgent(agentId);
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

    tabs.value.push(newTab);
    activeTabId.value = tabId;
    return tabId;
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
    setActiveTab,
    closeTab,
  };
});

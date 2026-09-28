<script setup lang="ts">
import { ref, onMounted, onUnmounted, toRaw } from 'vue';
import { useRoute } from 'vue-router';
import { useTerminalStore } from '@/stores/terminal';
import type { Agent } from '@remote/shared';
import type { TerminalSession } from '@remote/terminal-core';
import WorkspaceSidebar from '@/components/terminal/WorkspaceSidebar.vue';
import TerminalTabBar from '@/components/terminal/TerminalTabBar.vue';
import XtermTerminal from '@/components/terminal/XtermTerminal.vue';
import MobileAccessoryBar from '@/components/terminal/MobileAccessoryBar.vue';

const route = useRoute();
const terminalStore = useTerminalStore();
const sidebarOpen = ref(true);

function handleConnect(agent: Agent) {
  terminalStore.openTab(
    agent.id,
    agent.hostname || `Agent ${agent.id.slice(0, 6)}`,
  );
}

function handleSendKey(char: string) {
  if (terminalStore.activeTab) {
    terminalStore.activeTab.session.write(char);
  }
}

function handleKeyDown(event: KeyboardEvent) {
  const isMac = navigator.platform.includes('Mac');
  const ctrlOrCmd = isMac ? event.metaKey : event.ctrlKey;

  if (event.defaultPrevented) return;

  // Ctrl+Shift+T or Cmd+Shift+T: open new tab for first available agent
  if (ctrlOrCmd && event.shiftKey && event.key === 'T') {
    event.preventDefault();
    const firstAgent = terminalStore.tabs[0]?.agentId;
    if (firstAgent) {
      terminalStore.openTab(firstAgent);
    }
    return;
  }

  // Ctrl+W or Cmd+W: close active tab
  if (ctrlOrCmd && event.key === 'w' && !event.shiftKey) {
    event.preventDefault();
    if (terminalStore.activeTabId) {
      terminalStore.closeTab(terminalStore.activeTabId);
    }
    return;
  }

  // Alt+1..9: switch to tab index 0..8
  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    const digit = event.key;
    if (digit >= '1' && digit <= '9') {
      event.preventDefault();
      const idx = parseInt(digit, 10) - 1;
      const tab = terminalStore.tabs[idx];
      if (tab) {
        terminalStore.setActiveTab(tab.id);
      }
    }
  }
}

onMounted(() => {
  const initialAgentId = route.params.agentId as string | undefined;
  if (initialAgentId) {
    terminalStore.openTab(initialAgentId);
  }
  window.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown);
});
</script>

<template>
  <div class="flex h-screen w-screen overflow-hidden bg-background">
    <WorkspaceSidebar v-show="sidebarOpen" @connect-agent="handleConnect" />
    <button
      v-if="sidebarOpen"
      @click="sidebarOpen = false"
      class="absolute top-1/2 -translate-y-1/2 left-60 z-10 flex items-center justify-center w-6 h-10 bg-card border border-border rounded-r-md shadow-md hover:bg-accent transition-colors group"
      title="Hide sidebar"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="text-muted-foreground group-hover:text-foreground"
      >
        <line x1="19" y1="12" x2="5" y2="12"></line>
        <polyline points="12 19 5 12 12 5"></polyline>
      </svg>
    </button>
    <button
      v-else
      @click="sidebarOpen = true"
      class="fixed top-1/2 -translate-y-1/2 left-2 z-10 flex items-center justify-center w-6 h-10 bg-card border border-border rounded-r-md shadow-md hover:bg-accent transition-colors group"
      title="Show sidebar"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="text-muted-foreground group-hover:text-foreground"
      >
        <line x1="5" y1="12" x2="19" y2="12"></line>
        <polyline points="5" x2="12" y2="19" x1="12" y1="5"></polyline>
      </svg>
    </button>
    <div class="flex-1 flex flex-col h-full overflow-hidden">
      <TerminalTabBar
        :tabs="terminalStore.tabs"
        :active-tab-id="terminalStore.activeTabId"
        @select-tab="terminalStore.setActiveTab"
        @close-tab="terminalStore.closeTab"
        @new-tab="sidebarOpen = true"
      />
      <div class="flex-1 relative overflow-hidden bg-[#090d16]">
        <template v-if="terminalStore.activeTab">
          <XtermTerminal
            :key="terminalStore.activeTab.id"
            :session="toRaw(terminalStore.activeTab.session) as TerminalSession"
          />
        </template>
        <div
          v-else
          class="flex items-center justify-center h-full text-muted-foreground text-sm"
        >
          Select an agent from the sidebar to open a terminal session.
        </div>
      </div>
      <MobileAccessoryBar
        v-if="terminalStore.activeTab"
        class="md:hidden"
        @send-key="handleSendKey"
      />
    </div>
  </div>
</template>

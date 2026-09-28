<script setup lang="ts">
import { ref, onMounted, toRaw } from 'vue';
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
  terminalStore.openTab(agent.id, agent.hostname || `Agent ${agent.id.slice(0, 6)}`);
}

function handleSendKey(char: string) {
  if (terminalStore.activeTab) {
    terminalStore.activeTab.session.write(char);
  }
}

onMounted(() => {
  const initialAgentId = route.params.agentId as string | undefined;
  if (initialAgentId) {
    terminalStore.openTab(initialAgentId);
  }
});
</script>

<template>
  <div class="flex h-screen w-screen overflow-hidden bg-background">
    <WorkspaceSidebar
      v-show="sidebarOpen"
      @connect-agent="handleConnect"
    />
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

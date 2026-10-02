<script setup lang="ts">
import { ref, onMounted, onUnmounted, toRaw } from 'vue';
import { useRoute } from 'vue-router';
import { useTerminalStore } from '@/stores/terminal';
import type { TabItem } from '@/stores/terminal';
import type { Agent } from '@ponter/shared';
import type { TerminalSession } from '@ponter/terminal-core';
import WorkspaceSidebar from '@/components/terminal/WorkspaceSidebar.vue';
import TerminalTabBar from '@/components/terminal/TerminalTabBar.vue';
import XtermTerminal from '@/components/terminal/XtermTerminal.vue';
import DesktopView from '@/components/desktop/DesktopView.vue';
import MobileAccessoryBar from '@/components/terminal/MobileAccessoryBar.vue';
import { Button } from '@/components/ui/button';
import {
  ChevronLeft,
  ChevronRight,
  Terminal,
  Server,
  Radio,
  ShieldCheck,
  Keyboard,
  RefreshCw,
} from '@lucide/vue';

const route = useRoute();
const terminalStore = useTerminalStore();
const sidebarOpen = ref(true);

function handleConnect(agent: Agent) {
  terminalStore.openTab(
    agent.id,
    agent.hostname || `Agent ${agent.id.slice(0, 6)}`,
  );
}

function handleConnectDesktop(agent: Agent) {
  terminalStore.openDesktopTab(
    agent.id,
    agent.hostname || `Agent ${agent.id.slice(0, 6)}`,
  );
}

/**
 * Open another shell for the agent currently on screen, falling back to the
 * first tab's agent. With no tab open there is no agent to reuse, so the
 * sidebar is revealed for the user to pick one.
 */
function handleNewTab() {
  const agentId =
    terminalStore.activeTab?.agentId ?? terminalStore.tabs[0]?.agentId;
  if (agentId) {
    terminalStore.openTab(agentId);
  } else {
    sidebarOpen.value = true;
  }
}

function handleSendKey(char: string) {
  const session = terminalStore.activeTab?.session;
  if (session) {
    session.write(char);
  }
}

function handleKeyDown(event: KeyboardEvent) {
  const isMac = navigator.platform.includes('Mac');
  const ctrlOrCmd = isMac ? event.metaKey : event.ctrlKey;

  if (event.defaultPrevented) return;

  // Ctrl+Shift+T or Cmd+Shift+T: open a new shell for the active agent
  if (ctrlOrCmd && event.shiftKey && event.key === 'T') {
    event.preventDefault();
    handleNewTab();
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
  <div class="flex h-full min-h-0 w-full flex-1 overflow-hidden bg-background">
    <!-- Collapsible Agent Sidebar -->
    <WorkspaceSidebar
      v-show="sidebarOpen"
      @connect-agent="handleConnect"
      @connect-desktop="handleConnectDesktop"
    />

    <!-- Toggle button -->
    <button
      v-if="sidebarOpen"
      @click="sidebarOpen = false"
      class="absolute top-1/2 -translate-y-1/2 left-64 z-30 flex items-center justify-center w-5 h-10 bg-card border border-l-0 border-border rounded-r-md shadow-md hover:bg-accent transition-colors group"
      title="Hide sidebar"
    >
      <ChevronLeft
        class="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground"
      />
    </button>
    <button
      v-else
      @click="sidebarOpen = true"
      class="fixed top-1/2 -translate-y-1/2 left-0 z-30 flex items-center justify-center w-5 h-10 bg-card border border-border rounded-r-md shadow-md hover:bg-accent transition-colors group"
      title="Show sidebar"
    >
      <ChevronRight
        class="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground"
      />
    </button>

    <!-- Workspace Main Cockpit -->
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <TerminalTabBar
        :tabs="terminalStore.tabs"
        :active-tab-id="terminalStore.activeTabId"
        @select-tab="terminalStore.setActiveTab"
        @close-tab="terminalStore.closeTab"
        @retry-tab="terminalStore.retryTab"
        @new-tab="handleNewTab"
      />

      <!-- Terminal Body: the only scrollable region in the shell -->
      <div class="relative min-h-0 flex-1 overflow-hidden bg-[#090d16]">
        <template v-if="terminalStore.activeTab">
          <XtermTerminal
            v-if="terminalStore.activeTab.kind === 'terminal'"
            :key="terminalStore.activeTab.id"
            :session="toRaw(terminalStore.activeTab.session) as TerminalSession"
          />
          <DesktopView
            v-else
            :key="terminalStore.activeTab.id"
            :tab="terminalStore.activeTab as TabItem"
          />

          <!-- A connection failure used to be a silent unhandled rejection.
               Without this the user clicked an agent, saw nothing happen, and
               had no way to tell an offline agent from a blocked port. -->
          <div
            v-if="
              terminalStore.activeTab.kind === 'terminal' &&
              terminalStore.activeTab.status === 'error'
            "
            class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#090d16]/95 p-6 text-center"
          >
            <p class="text-sm text-destructive font-semibold">
              Could not connect to {{ terminalStore.activeTab.title }}
            </p>
            <p
              class="text-xs text-muted-foreground font-mono max-w-lg break-words"
            >
              {{ terminalStore.activeTab.error }}
            </p>
            <Button
              size="sm"
              variant="outline"
              class="text-xs flex items-center gap-2 border-border/80"
              :data-test="`retry-error-${terminalStore.activeTab.id}`"
              @click="terminalStore.retryTab(terminalStore.activeTab.id)"
            >
              <RefreshCw class="w-3.5 h-3.5" />
              Retry connection
            </Button>
          </div>
        </template>

        <!-- Empty State Cockpit -->
        <div
          v-else
          class="flex flex-col items-center justify-center h-full p-6 text-center space-y-4"
        >
          <div
            class="w-14 h-14 rounded-2xl bg-card border border-border/80 flex items-center justify-center text-primary shadow-lg"
          >
            <Terminal class="w-7 h-7" />
          </div>
          <div class="space-y-1.5 max-w-md">
            <h3 class="text-base font-semibold text-foreground tracking-tight">
              No Active Terminal Session
            </h3>
            <p class="text-xs text-muted-foreground">
              Select an agent from the fleet sidebar or click below to launch an
              interactive PTY shell over WebRTC.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            class="text-xs flex items-center gap-2 border-border/80"
            @click="sidebarOpen = true"
          >
            <Server class="w-3.5 h-3.5 text-primary" />
            Browse Connected Agents
          </Button>

          <!-- Hotkey cheatsheet in empty state -->
          <div
            class="pt-6 grid grid-cols-2 gap-3 text-left font-mono text-[11px] text-muted-foreground max-w-sm"
          >
            <div class="flex items-center gap-1.5">
              <span
                class="px-1.5 py-0.5 rounded bg-muted text-foreground border border-border"
                >Alt+1..9</span
              >
              <span>Switch tab</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span
                class="px-1.5 py-0.5 rounded bg-muted text-foreground border border-border"
                >Ctrl+Shift+T</span
              >
              <span>New shell</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span
                class="px-1.5 py-0.5 rounded bg-muted text-foreground border border-border"
                >Ctrl+W</span
              >
              <span>Close tab</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span
                class="px-1.5 py-0.5 rounded bg-muted text-foreground border border-border"
                >FitAddon</span
              >
              <span>Auto-resizing</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Telemetry Bottom Bar (when active tab exists) -->
      <footer
        v-if="terminalStore.activeTab"
        class="h-6 bg-card border-t border-border px-3 hidden sm:flex items-center justify-between text-[11px] font-mono text-muted-foreground select-none flex-shrink-0"
      >
        <div class="flex items-center gap-3">
          <span
            class="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400"
          >
            <span
              class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"
            ></span>
            <span>P2P Direct</span>
          </span>
          <span class="text-border">|</span>
          <span class="flex items-center gap-1">
            <Radio class="w-3 h-3 text-primary" />
            <span v-if="terminalStore.activeTab.kind === 'desktop'">
              Media: H.264 · view-only
            </span>
            <span v-else>Channel: terminal (64 KiB buffer)</span>
          </span>
          <span class="text-border">|</span>
          <span class="flex items-center gap-1">
            <ShieldCheck class="w-3 h-3 text-emerald-500" />
            <span>DTLS 1.2 / SCTP</span>
          </span>
        </div>

        <div class="flex items-center gap-2 text-[10px]">
          <Keyboard class="w-3 h-3 text-muted-foreground" />
          <span>Alt+1..9 switch · Ctrl+W close</span>
        </div>
      </footer>

      <!-- Mobile virtual keys -->
      <MobileAccessoryBar
        v-if="terminalStore.activeTab"
        class="md:hidden"
        @send-key="handleSendKey"
      />
    </div>
  </div>
</template>

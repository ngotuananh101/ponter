<script setup lang="ts">
import { ref, onMounted, onUnmounted, toRaw } from 'vue';
import { useRoute } from 'vue-router';
import { useTerminalStore } from '@/stores/terminal';
import { useFullscreen } from '@/composables/useFullscreen';
import type { TabItem } from '@/stores/terminal';
import type { Agent } from '@ponter/shared';
import type { TerminalSession } from '@ponter/terminal-core';
import WorkspaceSidebar from '@/components/terminal/WorkspaceSidebar.vue';
import TerminalTabBar from '@/components/terminal/TerminalTabBar.vue';
import XtermTerminal from '@/components/terminal/XtermTerminal.vue';
import ConnectionProgress from '@/components/terminal/ConnectionProgress.vue';
import DesktopView from '@/components/desktop/DesktopView.vue';
import FilesView from '@/components/files/FilesView.vue';
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

// Fullscreen acts on the terminal/desktop body, so the OS-level fullscreen
// hides the header, sidebar and tab strip along with it.
const sessionBodyRef = ref<HTMLElement | null>(null);
const {
  isFullscreen,
  isSupported: fullscreenSupported,
  toggle: toggleFullscreen,
} = useFullscreen(sessionBodyRef);

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

function handleConnectFiles(agent: Agent) {
  terminalStore.openFilesTab(
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

  // Ctrl+Shift+F or Cmd+Shift+F: toggle fullscreen for the active session.
  // Esc remains the browser's native way out; this is the way in.
  if (ctrlOrCmd && event.shiftKey && event.key === 'F') {
    event.preventDefault();
    if (terminalStore.activeTab && fullscreenSupported) {
      void toggleFullscreen();
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
      @connect-files="handleConnectFiles"
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
        :fullscreen-active="isFullscreen"
        :fullscreen-supported="fullscreenSupported"
        @select-tab="terminalStore.setActiveTab"
        @close-tab="terminalStore.closeTab"
        @retry-tab="terminalStore.retryTab"
        @new-tab="handleNewTab"
        @toggle-fullscreen="toggleFullscreen"
      />

      <!-- Terminal Body: the only scrollable region in the shell. This is the
           fullscreen target, so entering fullscreen drops the header, sidebar
           and tab strip and gives the session the whole screen. -->
      <div
        ref="sessionBodyRef"
        class="workspace-session relative min-h-0 flex-1 overflow-hidden bg-[#090d16]"
      >
        <template v-if="terminalStore.activeTab">
          <!-- A terminal tab exists before its session does: the store pushes it
               at click time so the user sees the tab immediately, and the
               handshake fills in `session` once the channel is up. xterm only
               mounts once the session exists. -->
          <XtermTerminal
            v-if="
              terminalStore.activeTab.kind === 'terminal' &&
              terminalStore.activeTab.session
            "
            :key="terminalStore.activeTab.id"
            :session="toRaw(terminalStore.activeTab.session) as TerminalSession"
          />
          <DesktopView
            v-else-if="terminalStore.activeTab.kind === 'desktop'"
            :key="terminalStore.activeTab.id"
            :tab="terminalStore.activeTab as TabItem"
          />
          <FilesView
            v-else-if="terminalStore.activeTab.kind === 'files'"
            :key="terminalStore.activeTab.id"
            :tab="terminalStore.activeTab as TabItem"
          />

          <!-- The step list overlays the body while a terminal or files
               handshake runs, including the final stage after the session
               exists — xterm is already mounted underneath, so the first PTY
               output flips the tab active and reveals it. (Desktop owns its own
               progress overlay inside DesktopView, next to its error overlay.)
               A failed tab shows the error overlay below instead. -->
          <ConnectionProgress
            v-if="
              (terminalStore.activeTab.kind === 'terminal' ||
                terminalStore.activeTab.kind === 'files') &&
              terminalStore.activeTab.status === 'connecting'
            "
            :tab="terminalStore.activeTab as TabItem"
          />

          <!-- A connection failure used to be a silent unhandled rejection.
               Without this the user clicked an agent, saw nothing happen, and
               had no way to tell an offline agent from a blocked port. -->
          <div
            v-if="
              (terminalStore.activeTab.kind === 'terminal' ||
                terminalStore.activeTab.kind === 'files') &&
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
                >Ctrl+Shift+F</span
              >
              <span>Fullscreen</span>
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
            <span
              v-if="terminalStore.activeTab.kind === 'desktop'"
              data-test="footer-media"
            >
              Media: H.264 ·
              {{
                terminalStore.activeTab.desktopStats
                  ? `${terminalStore.activeTab.desktopStats.width}×${terminalStore.activeTab.desktopStats.height}`
                  : 'connecting'
              }}
              <!-- Only once the agent reports the gate: the closed default shows
                   the media line alone, so an inert feature is never advertised
                   (spec §7.4, ADR-29). -->
              <template
                v-if="terminalStore.activeTab.desktopInputEnabled !== undefined"
              >
                ·
                {{
                  terminalStore.activeTab.desktopInputEnabled
                    ? 'input on'
                    : 'input off'
                }}
              </template>
            </span>
            <span v-else-if="terminalStore.activeTab.kind === 'files'">
              Channel: files (64 KiB buffer)
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
          <span>Alt+1..9 switch · Ctrl+W close · Ctrl+Shift+F fullscreen</span>
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

<style scoped>
/* The body carries Tailwind's `relative`, and an author rule outranks the UA
   stylesheet's `:fullscreen { position: fixed }` — so without this the element
   would stay in flow and fullscreen would render it at its old box. Re-assert
   the fullscreen geometry explicitly. */
.workspace-session:fullscreen {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>

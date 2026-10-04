<script setup lang="ts">
import {
  Plus,
  RefreshCw,
  X,
  Terminal,
  Monitor,
  Folder,
  Loader2,
} from '@lucide/vue';
import { ScrollArea } from '@/components/ui/scroll-area';
import FullscreenToggle from '@/components/terminal/FullscreenToggle.vue';

defineProps<{
  tabs: Array<{
    id: string;
    title: string;
    status: string;
    kind: 'terminal' | 'desktop' | 'files';
  }>;
  activeTabId: string | null;
  /** Fullscreen state of the session body, owned by the workspace view. */
  fullscreenActive?: boolean;
  fullscreenSupported?: boolean;
}>();

defineEmits<{
  (e: 'selectTab', tabId: string): void;
  (e: 'closeTab', tabId: string): void;
  (e: 'retryTab', tabId: string): void;
  (e: 'newTab'): void;
  (e: 'toggleFullscreen'): void;
}>();
</script>

<template>
  <div
    class="flex h-10 flex-shrink-0 items-center bg-card/95 border-b border-border select-none"
  >
    <!-- The strip scrolls horizontally; the "+" stays pinned so a new shell is
         always one click away no matter how many tabs are open. -->
    <ScrollArea orientation="horizontal" class="min-w-0 flex-1">
      <div class="flex h-10 items-center gap-1 px-2">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="flex items-center gap-2 px-3 py-1.5 text-xs rounded-t border-t border-x cursor-pointer transition-colors group"
          :class="
            tab.id === activeTabId
              ? 'bg-[#090d16] border-border text-foreground font-medium'
              : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground'
          "
          @click="$emit('selectTab', tab.id)"
        >
          <!-- Connecting swaps the status dot for a spinner, so a tab that is
               still handshaking reads as "working" rather than merely amber. -->
          <Loader2
            v-if="tab.status === 'connecting'"
            class="w-3 h-3 flex-shrink-0 text-amber-500 motion-safe:animate-spin"
            :data-test="`tab-spinner-${tab.id}`"
            aria-label="Connecting"
          />
          <span
            v-else
            class="w-2 h-2 rounded-full flex-shrink-0"
            :class="{
              'bg-emerald-500': tab.status === 'active',
              'bg-muted-foreground/40': tab.status === 'exited',
              'bg-destructive': tab.status === 'error',
            }"
          />
          <Monitor
            v-if="tab.kind === 'desktop'"
            class="w-3.5 h-3.5 flex-shrink-0"
          />
          <Folder
            v-else-if="tab.kind === 'files'"
            class="w-3.5 h-3.5 flex-shrink-0"
          />
          <Terminal v-else class="w-3.5 h-3.5 flex-shrink-0" />
          <span class="truncate max-w-[130px] font-mono">{{ tab.title }}</span>
          <button
            v-if="tab.status === 'error'"
            :data-test="`retry-tab-${tab.id}`"
            class="hover:text-foreground hover:bg-muted rounded p-0.5 transition-colors opacity-70 group-hover:opacity-100"
            title="Retry connection"
            @click.stop="$emit('retryTab', tab.id)"
          >
            <RefreshCw class="w-3.5 h-3.5" />
          </button>
          <button
            :data-test="`close-tab-${tab.id}`"
            class="hover:text-destructive hover:bg-destructive/10 rounded p-0.5 transition-colors opacity-70 group-hover:opacity-100"
            title="Close tab"
            @click.stop="$emit('closeTab', tab.id)"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </ScrollArea>
    <!-- The fullscreen control rides with the pinned "+", so it stays reachable
         however many tabs are open. It only appears once a session is on
         screen; the workspace view passes the state and handles the toggle. -->
    <FullscreenToggle
      v-if="activeTabId"
      variant="inline"
      :active="!!fullscreenActive"
      :supported="!!fullscreenSupported"
      :label="tabs.find((t) => t.id === activeTabId)?.title"
      @toggle="$emit('toggleFullscreen')"
    />
    <button
      class="p-1.5 mr-1 hover:bg-muted text-muted-foreground hover:text-foreground rounded-md transition-colors flex-shrink-0"
      title="Open new tab"
      @click="$emit('newTab')"
    >
      <Plus class="w-4 h-4" />
    </button>
  </div>
</template>

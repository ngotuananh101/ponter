<script setup lang="ts">
import { Plus, RefreshCw, X } from '@lucide/vue';

defineProps<{
  tabs: Array<{ id: string; title: string; status: string }>;
  activeTabId: string | null;
}>();

defineEmits<{
  (e: 'selectTab', tabId: string): void;
  (e: 'closeTab', tabId: string): void;
  (e: 'retryTab', tabId: string): void;
  (e: 'newTab'): void;
}>();
</script>

<template>
  <div
    class="flex h-10 flex-shrink-0 items-center bg-card/95 border-b border-border px-2 overflow-x-auto select-none"
  >
    <div class="flex items-center gap-1 flex-1 overflow-x-auto">
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
        <span
          class="w-2 h-2 rounded-full flex-shrink-0"
          :class="{
            'bg-emerald-500': tab.status === 'active',
            'bg-amber-500 animate-pulse': tab.status === 'connecting',
            'bg-muted-foreground/40': tab.status === 'exited',
            'bg-destructive': tab.status === 'error',
          }"
        />
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
    <button
      class="p-1.5 ml-2 hover:bg-muted text-muted-foreground hover:text-foreground rounded-md transition-colors"
      title="Open new tab"
      @click="$emit('newTab')"
    >
      <Plus class="w-4 h-4" />
    </button>
  </div>
</template>

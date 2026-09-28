<script setup lang="ts">
import { Plus, X } from '@lucide/vue';

defineProps<{
  tabs: Array<{ id: string; title: string; status: string }>;
  activeTabId: string | null;
}>();

defineEmits<{
  (e: 'selectTab', tabId: string): void;
  (e: 'closeTab', tabId: string): void;
  (e: 'newTab'): void;
}>();
</script>

<template>
  <div class="flex items-center bg-card border-b border-border px-2 h-10 overflow-x-auto select-none">
    <div class="flex items-center gap-1 flex-1 overflow-x-auto">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="flex items-center gap-2 px-3 py-1.5 text-xs rounded-t border-t border-x cursor-pointer transition-colors"
        :class="
          tab.id === activeTabId
            ? 'bg-[#090d16] border-border text-foreground font-medium'
            : 'bg-muted/40 border-transparent text-muted-foreground hover:bg-muted'
        "
        @click="$emit('selectTab', tab.id)"
      >
        <span
          class="w-2 h-2 rounded-full"
          :class="{
            'bg-green-500': tab.status === 'active',
            'bg-yellow-500 animate-pulse': tab.status === 'connecting',
            'bg-gray-400': tab.status === 'exited',
            'bg-red-500': tab.status === 'error',
          }"
        />
        <span class="truncate max-w-[120px]">{{ tab.title }}</span>
        <button
          :data-test="`close-tab-${tab.id}`"
          class="hover:text-destructive rounded p-0.5"
          @click.stop="$emit('closeTab', tab.id)"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
    <button
      class="p-1.5 ml-2 hover:bg-muted text-muted-foreground hover:text-foreground rounded transition-colors"
      title="Open new tab"
      @click="$emit('newTab')"
    >
      <Plus class="w-4 h-4" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { apiClient } from '@/services/client';
import type { Agent } from '@remote/shared';
import { Terminal, RefreshCw } from '@lucide/vue';

defineEmits<{
  (e: 'connectAgent', agent: Agent): void;
}>();

const agents = ref<Agent[]>([]);
const loading = ref(false);

async function loadAgents() {
  loading.value = true;
  try {
    agents.value = await apiClient.agents.list();
  } catch (err) {
    console.error('Failed to load agents', err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadAgents();
});
</script>

<template>
  <div
    class="w-64 bg-card border-r border-border flex flex-col h-full select-none"
  >
    <div class="p-3 border-b border-border flex items-center justify-between">
      <span
        class="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >Agents</span
      >
      <button
        class="text-muted-foreground hover:text-foreground p-1 rounded"
        :class="{ 'animate-spin': loading }"
        @click="loadAgents"
      >
        <RefreshCw class="w-3.5 h-3.5" />
      </button>
    </div>
    <div class="flex-1 overflow-y-auto p-2 space-y-1">
      <div
        v-if="agents.length === 0"
        class="text-xs text-center py-6 text-muted-foreground"
      >
        No agents found
      </div>
      <div
        v-for="a in agents"
        :key="a.id"
        class="flex items-center justify-between p-2 rounded hover:bg-muted cursor-pointer transition-colors text-xs"
        @click="$emit('connectAgent', a)"
      >
        <div class="flex items-center gap-2 truncate">
          <span
            class="w-2 h-2 rounded-full flex-shrink-0"
            :class="a.isOnline ? 'bg-green-500' : 'bg-gray-400'"
          />
          <span class="truncate font-medium">{{ a.hostname || a.id }}</span>
        </div>
        <Terminal class="w-3.5 h-3.5 text-muted-foreground" />
      </div>
    </div>
  </div>
</template>

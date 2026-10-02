<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { apiClient } from '@/services/client';
import type { Agent } from '@ponter/shared';
import { Terminal, Monitor, RefreshCw, Server, Search } from '@lucide/vue';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';

defineEmits<{
  (e: 'connectAgent', agent: Agent): void;
  (e: 'connectDesktop', agent: Agent): void;
}>();

const agents = ref<Agent[]>([]);
const loading = ref(false);
const searchQuery = ref('');

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

const filteredAgents = computed(() => {
  if (!searchQuery.value) return agents.value;
  const q = searchQuery.value.toLowerCase();
  return agents.value.filter(
    (a) =>
      (a.hostname && a.hostname.toLowerCase().includes(q)) ||
      a.id.toLowerCase().includes(q) ||
      (a.platform && a.platform.toLowerCase().includes(q)),
  );
});

onMounted(() => {
  loadAgents();
});
</script>

<template>
  <aside
    class="w-64 bg-card/95 border-r border-border flex flex-col h-full select-none flex-shrink-0 z-20"
  >
    <!-- Header: matches the tab-strip height (h-10) so the sidebar and
         terminal headers share one continuous baseline. -->
    <div
      class="h-10 flex-shrink-0 px-3 border-b border-border flex items-center justify-between"
    >
      <div class="flex items-center gap-2">
        <Server class="w-4 h-4 text-primary" />
        <span
          class="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Agent Fleet
        </span>
      </div>
      <div class="flex items-center gap-1.5">
        <Badge variant="outline" class="font-mono text-[10px] px-1.5 py-0">
          {{ agents.filter((a) => a.isOnline).length }}/{{ agents.length }}
        </Badge>
        <button
          class="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-muted transition-colors"
          :class="{ 'animate-spin': loading }"
          title="Refresh agents"
          @click="loadAgents"
        >
          <RefreshCw class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>

    <!-- Quick search input -->
    <div class="p-2 border-b border-border/60">
      <div class="relative">
        <Search
          class="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          v-model="searchQuery"
          type="text"
          placeholder="Filter host..."
          class="h-7 text-xs font-mono pl-8 bg-background/50 border-border/60"
        />
      </div>
    </div>

    <!-- Agent list -->
    <ScrollArea class="min-h-0 flex-1">
      <div class="p-2 space-y-1">
        <div
          v-if="filteredAgents.length === 0"
          class="text-xs text-center py-8 text-muted-foreground space-y-1"
        >
          <p>
            {{
              agents.length === 0
                ? 'No agents registered'
                : 'No matching agents'
            }}
          </p>
        </div>
        <div
          v-for="a in filteredAgents"
          :key="a.id"
          class="group flex items-center justify-between p-2 rounded-md hover:bg-muted/70 cursor-pointer transition-all border border-transparent hover:border-border/60 text-xs"
          @click="$emit('connectAgent', a)"
        >
          <div class="flex items-center gap-2 truncate">
            <span class="relative flex h-2 w-2 flex-shrink-0">
              <span
                v-if="a.isOnline"
                class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"
              ></span>
              <span
                class="relative inline-flex rounded-full h-2 w-2"
                :class="
                  a.isOnline ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                "
              ></span>
            </span>
            <div class="flex flex-col truncate">
              <span
                class="truncate font-medium text-foreground group-hover:text-primary transition-colors"
              >
                {{ a.hostname || a.id }}
              </span>
              <span
                class="text-[10px] text-muted-foreground font-mono truncate"
              >
                {{ a.platform || 'Linux' }} · {{ a.id.slice(0, 8) }}
              </span>
            </div>
          </div>
          <div class="flex items-center gap-1">
            <button
              class="p-1 rounded bg-muted/50 group-hover:bg-primary/10 group-hover:text-primary transition-colors text-muted-foreground"
              title="Open terminal"
              :data-test="`connect-terminal-${a.id}`"
              @click.stop="$emit('connectAgent', a)"
            >
              <Terminal class="w-3.5 h-3.5" />
            </button>
            <button
              v-if="a.capabilities.includes('desktop')"
              class="p-1 rounded bg-muted/50 group-hover:bg-primary/10 group-hover:text-primary transition-colors text-muted-foreground"
              title="Open desktop stream"
              :data-test="`connect-desktop-${a.id}`"
              @click.stop="$emit('connectDesktop', a)"
            >
              <Monitor class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </ScrollArea>
  </aside>
</template>

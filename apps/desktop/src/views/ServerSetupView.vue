<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '@/stores/config';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Server, Globe, Loader2 } from '@lucide/vue';
import ThemeToggle from '@/components/ThemeToggle.vue';
import type { ProbeResult } from '@/types';

const config = useConfigStore();
const url = ref(config.serverUrl || 'http://localhost:8787');
const probe = ref<ProbeResult | null>(null);
const loading = ref(false);

onMounted(() => {
  if (config.serverUrl) url.value = config.serverUrl;
});

async function connect() {
  loading.value = true;
  probe.value = null;
  try {
    probe.value = await invoke<ProbeResult>('probe_server', { url: url.value });
    if (probe.value.ok) {
      try {
        await config.setServerUrl(url.value.trim());
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        probe.value = { ok: false, message };
      }
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div data-testid="server-setup-root" class="w-full max-w-md">
    <Card class="border-border/80 bg-card/95 shadow-xl backdrop-blur-sm">
      <CardHeader class="space-y-2 pb-4">
        <div class="flex items-center justify-between">
          <div
            class="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary"
          >
            <Server class="w-5 h-5" />
          </div>
          <ThemeToggle />
        </div>
        <div>
          <CardTitle class="text-2xl font-bold tracking-tight">Server Connection</CardTitle>
          <CardDescription data-testid="server-setup-help" class="text-sm text-muted-foreground mt-0.5">
            Enter your Ponter server URL to verify connectivity.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="space-y-2">
          <Label for="server-setup-url" class="text-xs font-medium text-foreground flex items-center gap-1.5">
            <Globe class="w-3.5 h-3.5 text-muted-foreground" />
            Server URL
          </Label>
          <Input
            id="server-setup-url"
            type="url"
            data-testid="server-setup-url"
            placeholder="http://localhost:8787"
            v-model="url"
            :disabled="loading"
            class="bg-background/60 text-sm focus-visible:ring-primary font-mono"
            @keydown.enter.prevent="connect"
          />
        </div>

        <Alert
          v-if="probe && !probe.ok"
          data-testid="server-setup-message"
          variant="destructive"
          role="alert"
          aria-live="polite"
        >
          <AlertDescription>{{ probe.message }}</AlertDescription>
        </Alert>

        <Button
          data-testid="server-setup-connect"
          :disabled="loading || !url"
          class="w-full font-medium"
          @click="connect"
        >
          <Loader2 v-if="loading" class="mr-2 h-4 w-4 animate-spin" />
          {{ loading ? 'Probing...' : 'Connect' }}
        </Button>
      </CardContent>
    </Card>
  </div>
</template>

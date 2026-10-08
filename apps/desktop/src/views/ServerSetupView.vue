<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '@/stores/config';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from '@lucide/vue';
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
      await config.setServerUrl(url.value.trim());
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div
    data-testid="server-setup-root"
    class="container flex min-h-screen flex-col items-center justify-center"
  >
    <h1>Server Connection</h1>
    <p data-testid="server-setup-help">
      Enter your Ponter server URL to verify connectivity.
    </p>

    <Label for="server-setup-url" class="sr-only">Server URL</Label>
    <Input
      id="server-setup-url"
      type="url"
      data-testid="server-setup-url"
      placeholder="http://localhost:8787"
      v-model="url"
    />

    <Button
      data-testid="server-setup-connect"
      :disabled="loading || !url"
      @click="connect"
    >
      <Loader2 v-if="loading" class="mr-2 h-4 w-4 animate-spin" />
      {{ loading ? 'Probing...' : 'Connect' }}
    </Button>

    <Alert
      v-if="probe && !probe.ok"
      data-testid="server-setup-message"
      variant="destructive"
      role="alert"
      aria-live="polite"
    >
      <AlertDescription>{{ probe.message }}</AlertDescription>
    </Alert>
  </div>
</template>

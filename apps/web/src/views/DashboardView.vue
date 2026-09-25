<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { apiClient } from '@/services/client';
import type { Device, Agent } from '@remote/shared';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

const authStore = useAuthStore();
const devices = ref<Device[]>([]);
const agents = ref<Agent[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

async function loadDashboardData() {
  loading.value = true;
  error.value = null;
  try {
    const [devs, agts] = await Promise.all([
      apiClient.devices.list(),
      apiClient.agents.list(),
    ]);
    devices.value = devs;
    agents.value = agts;
  } catch (err) {
    error.value =
      err instanceof Error ? err.message : 'Failed to load dashboard data';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadDashboardData();
});
</script>

<template>
  <div class="container mx-auto p-4 md:p-8 space-y-8">
    <div
      class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border pb-6"
    >
      <div>
        <h1 class="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p class="text-muted-foreground mt-1">
          Welcome back,
          <span class="font-medium text-foreground">{{
            authStore.user?.username
          }}</span>
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        :disabled="loading"
        @click="loadDashboardData"
      >
        Refresh Data
      </Button>
    </div>

    <Alert v-if="error" variant="destructive">
      <AlertDescription class="flex justify-between items-center">
        <span>{{ error }}</span>
        <Button variant="outline" size="sm" @click="loadDashboardData"
          >Retry</Button
        >
      </AlertDescription>
    </Alert>

    <div v-if="loading" class="grid gap-6 md:grid-cols-2">
      <Card class="p-8 text-center text-muted-foreground animate-pulse"
        >Loading devices...</Card
      >
      <Card class="p-8 text-center text-muted-foreground animate-pulse"
        >Loading agents...</Card
      >
    </div>

    <div v-else class="grid gap-6 md:grid-cols-2">
      <!-- Devices Card -->
      <Card>
        <CardHeader>
          <div class="flex items-center justify-between">
            <div>
              <CardTitle>Registered Devices</CardTitle>
              <CardDescription
                >Authorized browsers and hardware</CardDescription
              >
            </div>
            <Badge variant="secondary">{{ devices.length }}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div
            v-if="devices.length === 0"
            class="text-center py-6 text-muted-foreground text-sm"
          >
            No devices registered yet.
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="d in devices"
              :key="d.id"
              class="flex items-center justify-between p-3 rounded-lg border border-border bg-card"
            >
              <div>
                <p class="font-medium text-sm">
                  {{ d.deviceName || 'Unnamed Device' }}
                </p>
                <p class="text-xs text-muted-foreground font-mono">
                  {{ d.fingerprint.slice(0, 16) }}...
                </p>
              </div>
              <Badge :variant="d.isTrusted ? 'default' : 'outline'">
                {{ d.deviceType }}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Agents Card -->
      <Card>
        <CardHeader>
          <div class="flex items-center justify-between">
            <div>
              <CardTitle>Connected Agents</CardTitle>
              <CardDescription>Remote target systems</CardDescription>
            </div>
            <Badge variant="secondary">{{ agents.length }}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div
            v-if="agents.length === 0"
            class="text-center py-6 text-muted-foreground text-sm"
          >
            No agents registered yet.
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="a in agents"
              :key="a.id"
              class="flex items-center justify-between p-3 rounded-lg border border-border bg-card"
            >
              <div>
                <p class="font-medium text-sm">{{ a.hostname || a.id }}</p>
                <p class="text-xs text-muted-foreground">
                  {{ a.platform || 'Unknown OS' }}
                </p>
              </div>
              <Badge :variant="a.isOnline ? 'default' : 'secondary'">
                {{ a.isOnline ? 'Online' : 'Offline' }}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>

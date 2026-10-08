<script setup lang="ts">
import { onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useDevicesStore } from '@/stores/devices';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';

const authStore = useAuthStore();
const store = useDevicesStore();

async function handleRegister() {
  await store.register();
}

async function handleDelete(deviceId: string) {
  const confirmed = window.confirm(
    `Delete device "${deviceId}"? This cannot be undone.`,
  );
  if (!confirmed) return;
  await store.remove(deviceId);
}

onMounted(() => {
  void store.refresh();
});
</script>

<template>
  <div data-testid="devices-root">
    <Card>
      <CardHeader>
        <CardTitle>Devices</CardTitle>
        <CardDescription data-testid="devices-username">
          Signed in as {{ authStore.user?.username }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Alert
          v-if="store.error"
          data-testid="devices-error"
          variant="destructive"
        >
          <AlertDescription>{{ store.error }}</AlertDescription>
        </Alert>

        <div v-if="store.loading" data-testid="devices-loading">
          Loading devices...
        </div>

        <p v-else-if="store.devices.length === 0" data-testid="devices-empty">
          No devices registered yet
        </p>

        <ul v-else data-testid="devices-list" class="space-y-2">
          <li
            v-for="device in store.devices"
            :key="device.id"
            data-testid="device-row"
            class="flex items-center justify-between"
          >
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2">
                <span data-testid="device-id">{{ device.id }}</span>
                <span data-testid="device-hostname">{{ device.hostname }}</span>
                <Badge
                  :variant="device.isOnline ? 'default' : 'secondary'"
                  data-testid="device-platform"
                >
                  {{ device.platform ?? 'unknown' }}
                  <Badge
                    data-testid="device-online"
                    :variant="device.isOnline ? 'default' : 'secondary'"
                  >
                    {{ device.isOnline ? 'online' : 'offline' }}
                  </Badge>
                </Badge>
              </div>
              <span data-testid="device-created">{{ device.createdAt }}</span>
            </div>
            <Button
              data-testid="device-delete"
              :data-testid-device="device.id"
              variant="destructive"
              @click="handleDelete(device.id)"
            >
              Delete
            </Button>
          </li>
        </ul>
      </CardContent>
      <CardFooter class="flex flex-col items-stretch gap-2">
        <Button
          data-testid="devices-register"
          :disabled="store.loading"
          @click="handleRegister"
        >
          {{ store.loading ? 'Registering...' : 'Register this device' }}
        </Button>
        <p v-if="!store.registered" data-testid="devices-register-hint">
          The agent runtime runs from the system tray.
        </p>
      </CardFooter>
    </Card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const authStore = useAuthStore();
const store = useDevicesStore();

const deleteDialogOpen = ref(false);
const deleteTarget = ref<string | null>(null);

async function handleRegister() {
  await store.register();
}

function handleDelete(deviceId: string) {
  deleteTarget.value = deviceId;
  deleteDialogOpen.value = true;
}

async function confirmDelete() {
  if (!deleteTarget.value) return;
  const deviceId = deleteTarget.value;
  deleteDialogOpen.value = false;
  deleteTarget.value = null;
  await store.remove(deviceId);
}

function cancelDelete() {
  deleteDialogOpen.value = false;
  deleteTarget.value = null;
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
          {{ store.loading ? 'Registering...' : 'Register Device' }}
        </Button>
        <p v-if="!store.registered" data-testid="devices-register-hint">
          The agent runtime runs from the system tray.
        </p>
      </CardFooter>

      <!-- Delete confirmation dialog -->
      <AlertDialog
        :open="deleteDialogOpen"
        @update:open="
          (val: boolean) => {
            deleteDialogOpen = val;
          }
        "
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete device?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel @click="cancelDelete">Cancel</AlertDialogCancel>
            <AlertDialogAction @click="confirmDelete">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
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
import {
  Laptop,
  LogOut,
  Plus,
  Info,
  Terminal,
  Monitor,
  Folder,
} from '@lucide/vue';
import ThemeToggle from '@/components/ThemeToggle.vue';

const authStore = useAuthStore();
const store = useDevicesStore();

const deleteDialogOpen = ref(false);
const deleteTarget = ref<string | null>(null);

/** Toggleable capabilities, mirroring the web dialog. */
const TOGGLEABLE_CAPABILITIES = ['terminal', 'desktop', 'files'] as const;

/** Default: terminal + desktop (files OFF — runtime has no files_root yet). */
const selectedCapabilities = ref<string[]>(['terminal', 'desktop']);

function toggleCapability(cap: string) {
  selectedCapabilities.value = selectedCapabilities.value.includes(cap)
    ? selectedCapabilities.value.filter((c) => c !== cap)
    : [...selectedCapabilities.value, cap];
}

function orderedCapabilities(): string[] {
  return TOGGLEABLE_CAPABILITIES.filter((c) =>
    selectedCapabilities.value.includes(c),
  );
}

/** Runtime status from the backend: connected | disconnected | stopped | unknown */
const runtimeStatus = ref<string>('unknown');
let unlistenRuntime: UnlistenFn | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;

async function probeRuntimeStatus() {
  try {
    const status = await invoke<string>('get_runtime_status');
    runtimeStatus.value = status;
  } catch {
    // Do not break the device list; surface a neutral state.
    runtimeStatus.value = 'unknown';
  }
}

async function handleRegister() {
  await store.register(orderedCapabilities());
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

onMounted(async () => {
  void store.refresh();
  await probeRuntimeStatus();
  try {
    unlistenRuntime = await listen<{ status: string }>(
      'runtime-status',
      (event) => {
        runtimeStatus.value = event.payload.status;
      },
    );
  } catch {
    // Event listener failed — keep neutral status.
  }
  // Auto-refresh the device list so online/offline badges stay correct.
  refreshInterval = setInterval(() => {
    void store.refresh();
  }, 5000);
});

onUnmounted(() => {
  if (unlistenRuntime) {
    unlistenRuntime();
  }
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
</script>

<template>
  <div data-testid="devices-root" class="w-full max-w-xl">
    <Card class="border-border/80 bg-card/95 shadow-xl backdrop-blur-sm">
      <CardHeader class="space-y-3 pb-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div
              class="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary"
            >
              <Laptop class="w-4 h-4" />
            </div>
            <div>
              <CardTitle class="text-xl font-bold tracking-tight"
                >Devices</CardTitle
              >
              <CardDescription
                data-testid="devices-username"
                class="text-xs text-muted-foreground font-mono"
              >
                Signed in as {{ authStore.user?.username }}
              </CardDescription>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <ThemeToggle />
            <Button
              data-testid="devices-logout"
              variant="ghost"
              size="sm"
              class="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1.5"
              @click="authStore.logout"
            >
              <LogOut class="w-3.5 h-3.5" />
              <span>Log out</span>
            </Button>
          </div>
        </div>
      </CardHeader>

      <div
        data-testid="runtime-status"
        :data-status="runtimeStatus"
        class="px-6 py-2 flex items-center gap-2 text-xs font-mono"
      >
        <span
          class="w-2 h-2 rounded-full"
          :class="
            runtimeStatus === 'connected'
              ? 'bg-emerald-400'
              : runtimeStatus === 'disconnected'
                ? 'bg-amber-400'
                : runtimeStatus === 'stopped'
                  ? 'bg-red-400'
                  : 'bg-muted-foreground'
          "
        />
        <span class="text-muted-foreground">Runtime:</span>
        <span class="text-foreground font-semibold">{{ runtimeStatus }}</span>
      </div>

      <CardContent class="space-y-4">
        <Alert
          v-if="store.error"
          data-testid="devices-error"
          variant="destructive"
        >
          <AlertDescription>{{ store.error }}</AlertDescription>
        </Alert>

        <div
          v-if="store.loading"
          data-testid="devices-loading"
          class="py-8 text-center text-sm text-muted-foreground font-mono"
        >
          Loading devices...
        </div>

        <div
          v-else-if="store.devices.length === 0"
          data-testid="devices-empty"
          class="py-8 text-center text-sm text-muted-foreground"
        >
          No devices registered yet
        </div>

        <ul v-else data-testid="devices-list" class="space-y-2.5">
          <li
            v-for="device in store.devices"
            :key="device.id"
            data-testid="device-row"
            class="p-3.5 rounded-lg border border-border/60 bg-muted/20 hover:bg-muted/30 transition-colors flex items-center justify-between gap-4"
          >
            <div class="flex flex-col gap-1.5 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span
                  data-testid="device-hostname"
                  class="font-semibold text-sm text-foreground"
                >
                  {{ device.hostname }}
                </span>
                <!-- Clean sibling badges (NO nesting defect) -->
                <Badge
                  variant="outline"
                  data-testid="device-platform"
                  class="text-[11px] font-mono px-1.5 py-0"
                >
                  {{ device.platform ?? 'unknown' }}
                </Badge>
                <Badge
                  data-testid="device-online"
                  :variant="device.isOnline ? 'default' : 'secondary'"
                  class="text-[11px] font-mono px-1.5 py-0 flex items-center gap-1"
                >
                  <span
                    v-if="device.isOnline"
                    class="w-1.5 h-1.5 rounded-full bg-emerald-400 motion-safe:animate-pulse"
                  />
                  {{ device.isOnline ? 'online' : 'offline' }}
                </Badge>
              </div>
              <div
                class="flex items-center gap-2 text-xs text-muted-foreground font-mono"
              >
                <span data-testid="device-id" class="truncate">{{
                  device.id
                }}</span>
                <span>·</span>
                <span data-testid="device-created">{{ device.createdAt }}</span>
              </div>
            </div>

            <Button
              data-testid="device-delete"
              variant="destructive"
              size="sm"
              class="shrink-0"
              @click="handleDelete(device.id)"
            >
              Delete
            </Button>
          </li>
        </ul>
      </CardContent>

      <CardFooter class="flex flex-col items-stretch gap-2.5 pt-2">
        <fieldset class="border-0 p-0 m-0 min-w-0">
          <legend class="text-xs font-semibold text-muted-foreground mb-1.5">
            Capabilities
          </legend>
          <div class="flex gap-1.5 mb-2">
            <button
              type="button"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all"
              :class="
                selectedCapabilities.includes('terminal')
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-card hover:bg-secondary/60 text-muted-foreground'
              "
              :aria-pressed="selectedCapabilities.includes('terminal')"
              :disabled="store.loading"
              data-test="register-cap-terminal"
              @click="toggleCapability('terminal')"
            >
              <Terminal class="w-3.5 h-3.5" />
              Terminal
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all"
              :class="
                selectedCapabilities.includes('desktop')
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-card hover:bg-secondary/60 text-muted-foreground'
              "
              :aria-pressed="selectedCapabilities.includes('desktop')"
              :disabled="store.loading"
              data-test="register-cap-desktop"
              @click="toggleCapability('desktop')"
            >
              <Monitor class="w-3.5 h-3.5" />
              Desktop
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all"
              :class="
                selectedCapabilities.includes('files')
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-card hover:bg-secondary/60 text-muted-foreground'
              "
              :aria-pressed="selectedCapabilities.includes('files')"
              :disabled="store.loading"
              data-test="register-cap-files"
              @click="toggleCapability('files')"
            >
              <Folder class="w-3.5 h-3.5" />
              Files
            </button>
          </div>
        </fieldset>

        <Button
          data-testid="devices-register"
          :disabled="store.loading"
          class="w-full font-medium"
          @click="handleRegister"
        >
          <Plus class="w-4 h-4 mr-1.5" />
          {{ store.loading ? 'Registering...' : 'Register Device' }}
        </Button>
        <p
          v-if="!store.registered"
          data-testid="devices-register-hint"
          class="text-xs text-muted-foreground text-center flex items-center justify-center gap-1.5"
        >
          <Info class="w-3.5 h-3.5 text-primary shrink-0" />
          <span>The agent runtime runs from the system tray.</span>
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

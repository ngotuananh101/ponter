<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useDevicesStore } from '@/stores/devices';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@ponter/ui-components';
import { Button } from '@ponter/ui-components';
import { Badge } from '@ponter/ui-components';
import { Alert, AlertDescription } from '@ponter/ui-components';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@ponter/ui-components';
import { ThemeToggle } from '@ponter/ui-components';
import {
  Laptop,
  LogOut,
  Copy,
  Check,
  Radio,
  ExternalLink,
  Trash2,
  Monitor,
  Terminal,
  Folder,
} from '@lucide/vue';

const authStore = useAuthStore();
const store = useDevicesStore();

const deleteDialogOpen = ref(false);
const deleteTarget = ref<string | null>(null);

/** Runtime status from the backend: connected | disconnected | stopped | unknown */
const runtimeStatus = ref<string>('unknown');

/**
 * `connected` means the agent PROCESS is alive, not that it authenticated over
 * the WebSocket — it can still be crash-looping. Label it honestly (PM ruling B,
 * Ticket #154); `data-status` keeps the raw value for machine-readable tests.
 */

let unsubscribeRuntime: (() => void) | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;

/** The device belonging to this machine (Ticket #154), or null. */
const localAgentId = ref<string | null>(null);

/** Hostname of this machine, loaded for display. */
const localHostname = ref<string | null>(null);

/** Platform of this machine, loaded for the badge. */
const localPlatform = ref<string | null>(null);

/** Error from an agent start/stop attempt, shown in its own alert. */
const agentError = ref<string | null>(null);

/** True while a start/stop request is in-flight (UI disable). */
const agentPending = ref(false);

/** True while the current machine is registering (background auto-register). */
const isRegistering = ref(false);

/** "Allow remote control" toggle state: true when the agent is running. */
const allowRemoteControl = computed(
  () =>
    runtimeStatus.value === 'connected' || runtimeStatus.value === 'starting',
);

/** Start/Stop availability follows the runtime state. */
const agentRunning = computed(
  () =>
    runtimeStatus.value === 'connected' || runtimeStatus.value === 'starting',
);

/** A start needs a local device to attach to. */
const canControlAgent = computed(() => localAgentId.value !== null);

/** Copy-ID visual feedback. */
const copiedId = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
// DOM timer helpers (typed for happy-dom / strict env).
const setDomTimer = (
  fn: () => void,
  ms: number,
): ReturnType<typeof setTimeout> => setTimeout(fn, ms);
const clearDomTimer = (t: ReturnType<typeof setTimeout>): void =>
  clearTimeout(t);

/** Remote-control form state. */
const remoteAgentId = ref('');
const remoteMode = ref<'desktop' | 'terminal' | 'files'>('desktop');
const connectPending = ref(false);
const remoteError = ref<string | null>(null);

const MODES: ('desktop' | 'terminal' | 'files')[] = [
  'desktop',
  'terminal',
  'files',
];
const MODE_LABELS: Record<'desktop' | 'terminal' | 'files', string> = {
  desktop: 'Desktop',
  terminal: 'Terminal',
  files: 'Files',
};
const MODE_ICONS: Record<'desktop' | 'terminal' | 'files', any> = {
  desktop: Monitor,
  terminal: Terminal,
  files: Folder,
};

async function loadLocalAgentId() {
  try {
    localAgentId.value = await window.ponter.getLocalAgentId();
    // Try to resolve a friendly hostname/platform for "This Device" from the
    // device list (the backend returns the full fleet); fall back to null.
    const devices = store.devices;
    const mine = devices.find((d) => d.id === localAgentId.value) ?? null;
    localHostname.value = mine?.hostname ?? null;
    localPlatform.value = mine?.platform ?? null;
  } catch {
    localAgentId.value = null;
    localHostname.value = null;
    localPlatform.value = null;
  }
}

function copyDeviceId(id: string | null) {
  if (!id) return;
  if (navigator?.clipboard?.writeText) {
    void navigator.clipboard.writeText(id);
  }
  copiedId.value = true;
  if (copiedTimer) clearDomTimer(copiedTimer);
  copiedTimer = setDomTimer(() => {
    copiedId.value = false;
  }, 2000);
}

async function probeRuntimeStatus() {
  try {
    runtimeStatus.value = await window.ponter.getRuntimeStatus();
  } catch {
    // Do not break the device list; surface a neutral state.
    runtimeStatus.value = 'unknown';
  }
}

async function handleStartAgent() {
  agentError.value = null;
  agentPending.value = true;
  try {
    const result = await window.ponter.startAgent();
    if (!result.ok) {
      agentError.value = result.message;
    }
    await probeRuntimeStatus();
  } catch (err) {
    agentError.value = err instanceof Error ? err.message : String(err);
  } finally {
    agentPending.value = false;
  }
}

async function handleStopAgent() {
  agentError.value = null;
  agentPending.value = true;
  try {
    await window.ponter.stopAgent();
    await probeRuntimeStatus();
  } catch (err) {
    agentError.value = err instanceof Error ? err.message : String(err);
  } finally {
    agentPending.value = false;
  }
}

/** Single "Allow remote control" toggle: ON(running) -> stop, OFF -> start. */
function handleAllowRemoteControlToggle() {
  if (allowRemoteControl.value) {
    void handleStopAgent();
  } else {
    void handleStartAgent();
  }
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
  // Deleting this machine's device also clears the local id in the backend.
  await loadLocalAgentId();
}

function cancelDelete() {
  deleteDialogOpen.value = false;
  deleteTarget.value = null;
}

async function handleRemoteConnect() {
  remoteError.value = null;
  if (!remoteAgentId.value.trim()) return;
  connectPending.value = true;
  try {
    const res = await window.ponter.openRemoteSession({
      agentId: remoteAgentId.value.trim(),
      mode: remoteMode.value,
    });
    if (!res.ok) {
      remoteError.value = res.message || 'Failed to open remote session';
    } else if (res.url) {
      // Open the remote session URL in a new window (E2EE/WS tunnel).
      window.open(res.url, '_blank');
    }
  } catch (err) {
    remoteError.value = err instanceof Error ? err.message : String(err);
  } finally {
    connectPending.value = false;
  }
}

async function handleDeviceConnect(deviceId: string) {
  remoteError.value = null;
  try {
    const res = await window.ponter.openRemoteSession({
      agentId: deviceId,
      mode: 'desktop',
    });
    if (!res.ok) {
      remoteError.value = res.message || 'Failed to open remote session';
    } else if (res.url) {
      window.open(res.url, '_blank');
    }
  } catch (err) {
    remoteError.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(async () => {
  await store.refresh();
  await probeRuntimeStatus();
  await loadLocalAgentId();

  // Ticket #154: auto-register this machine in the background if it has no
  // local agent yet. The capabilities mirror the old default (terminal+desktop).
  if (localAgentId.value === null) {
    isRegistering.value = true;
    try {
      await store.register(['terminal', 'desktop']);
      await loadLocalAgentId();
    } finally {
      isRegistering.value = false;
    }
  }

  // If the agent is allowed to auto-start (or already running), start it.
  let cfg: Awaited<ReturnType<typeof window.ponter.getConfig>> | null = null;
  try {
    cfg = await window.ponter.getConfig();
  } catch {
    cfg = null;
  }
  if (cfg?.agentAutoStart && !agentRunning.value) {
    void handleStartAgent();
  }

  // Listen for real-time runtime status updates pushed from the main process.
  unsubscribeRuntime = window.ponter.onRuntimeStatus((status: string) => {
    runtimeStatus.value = status;
  });

  // Auto-refresh the device list so online/offline badges stay correct.
  // Background mode avoids toggling `loading`, so the existing device list
  // stays mounted — preventing UI flicker on each 5-second interval tick.
  refreshInterval = setInterval(() => {
    void store.refresh({ background: true });
  }, 5000);
});

onUnmounted(() => {
  if (unsubscribeRuntime) {
    unsubscribeRuntime();
  }
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  if (copiedTimer) {
    clearDomTimer(copiedTimer);
  }
});
</script>

<template>
  <div data-testid="devices-root" class="w-full max-w-4xl mx-auto space-y-4">
    <!-- Header (kept intact) -->
    <Card class="border-border/80 bg-card/95 shadow-xl backdrop-blur-sm">
      <CardHeader class="pb-4">
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
    </Card>

    <!-- Errors -->
    <Alert v-if="store.error" data-testid="devices-error" variant="destructive">
      <AlertDescription>{{ store.error }}</AlertDescription>
    </Alert>

    <Alert v-if="agentError" data-testid="devices-error" variant="destructive">
      <AlertDescription>{{ agentError }}</AlertDescription>
    </Alert>

    <!-- 2-Column Grid: This Device | Remote Control -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <!-- LEFT COLUMN: This Device -->
      <Card class="border-border/80 bg-card/95">
        <CardHeader class="pb-3">
          <CardTitle class="text-lg font-semibold flex items-center gap-2">
            <Monitor class="w-4 h-4 text-primary" />
            This Device
          </CardTitle>
        </CardHeader>

        <CardContent class="space-y-3.5">
          <!-- Device info: hostname + platform badge -->
          <div v-if="localAgentId" class="flex items-center gap-2 text-sm">
            <span
              v-if="localHostname"
              data-testid="this-device-hostname"
              class="font-semibold text-foreground"
              >{{ localHostname }}</span
            >
            <span
              v-else
              data-testid="this-device-hostname"
              class="font-semibold text-foreground"
            >
              This machine
            </span>
            <Badge
              v-if="localPlatform"
              data-testid="this-device-platform"
              variant="outline"
              class="text-[11px] font-mono px-1.5 py-0"
            >
              {{ localPlatform }}
            </Badge>
          </div>

          <!-- Device ID (prominent, copyable) -->
          <div class="flex items-center gap-2">
            <code
              data-testid="this-device-id"
              class="font-mono text-base font-bold select-all break-all"
              >{{ localAgentId ?? '—' }}</code
            >
            <Button
              v-if="localAgentId"
              data-testid="copy-device-id"
              variant="ghost"
              size="xs"
              class="shrink-0"
              :disabled="!localAgentId"
              @click="copyDeviceId(localAgentId)"
            >
              <Check v-if="copiedId" class="w-3.5 h-3.5 text-emerald-500" />
              <Copy v-else class="w-3.5 h-3.5" />
            </Button>
          </div>

          <!-- Status & control -->
          <div class="pt-1 space-y-2.5">
            <div
              data-testid="runtime-status"
              :data-status="runtimeStatus"
              class="flex items-center gap-2 text-xs font-mono"
            >
              <span
                class="w-2 h-2 rounded-full"
                :class="
                  runtimeStatus === 'connected'
                    ? 'bg-emerald-400'
                    : runtimeStatus === 'starting'
                      ? 'bg-amber-400'
                      : runtimeStatus === 'stopped'
                        ? 'bg-red-400'
                        : 'bg-muted-foreground'
                "
              />
              <span class="text-muted-foreground">Status:</span>
              <span class="text-foreground font-semibold">{{
                runtimeStatus === 'connected'
                  ? 'Ready for remote connections'
                  : runtimeStatus === 'starting'
                    ? 'Starting...'
                    : 'Remote access paused'
              }}</span>
            </div>

            <div class="flex items-center gap-2">
              <Button
                data-testid="allow-remote-control-toggle"
                :data-state="allowRemoteControl ? 'on' : 'off'"
                :variant="allowRemoteControl ? 'default' : 'outline'"
                size="sm"
                class="h-7 text-xs font-medium"
                :disabled="agentPending || isRegistering || !canControlAgent"
                @click="handleAllowRemoteControlToggle"
              >
                <span
                  v-if="allowRemoteControl"
                  class="flex items-center gap-1.5"
                >
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  <span>Allowing connections</span>
                </span>
                <span v-else class="flex items-center gap-1.5">
                  <span class="w-1.5 h-1.5 rounded-full bg-muted-foreground" />
                  <span>Allow remote control</span>
                </span>
              </Button>

              <!-- Backward-compatible Start/Stop elements (hidden visually, keyed for tests). -->
              <Button
                v-if="agentRunning"
                data-testid="agent-stop"
                variant="outline"
                size="sm"
                class="hidden h-6 px-2 text-[11px]"
                :disabled="agentPending"
                @click="handleStopAgent"
              >
                Stop Agent
              </Button>
              <Button
                v-else
                data-testid="agent-start"
                variant="outline"
                size="sm"
                class="hidden h-6 px-2 text-[11px]"
                :disabled="agentPending || !canControlAgent"
                @click="handleStartAgent"
              >
                Start Agent
              </Button>
            </div>

            <p
              v-if="!canControlAgent"
              data-testid="agent-control-hint"
              class="text-xs text-muted-foreground"
            >
              Register this device to start its agent.
            </p>
          </div>
        </CardContent>
      </Card>

      <!-- RIGHT COLUMN: Remote Control -->
      <Card class="border-border/80 bg-card/95">
        <CardHeader class="pb-3">
          <CardTitle class="text-lg font-semibold flex items-center gap-2">
            <Radio class="w-4 h-4 text-primary" />
            Remote Control
          </CardTitle>
          <CardDescription class="text-xs text-muted-foreground">
            Connect to a partner's device by ID.
          </CardDescription>
        </CardHeader>

        <CardContent class="space-y-3.5">
          <div class="space-y-1.5">
            <label
              class="text-xs font-medium text-muted-foreground"
              for="remote-agent-id-input"
            >
              Partner Device ID
            </label>
            <input
              id="remote-agent-id-input"
              data-testid="remote-agent-id-input"
              v-model="remoteAgentId"
              placeholder="Enter partner's Device ID..."
              class="w-full h-9 px-3 py-1.5 text-sm font-mono rounded-md border border-input bg-background/60 shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
          </div>

          <!-- Mode selector -->
          <div class="flex gap-1.5">
            <Button
              v-for="mode in MODES"
              :key="mode"
              :data-testid="`remote-mode-${mode}`"
              variant="ghost"
              size="sm"
              class="h-7 text-xs font-medium"
              :class="
                remoteMode === mode
                  ? 'border border-primary bg-primary/10 text-primary'
                  : 'border border-border'
              "
              :aria-pressed="remoteMode === mode"
              @click="remoteMode = mode"
            >
              <component :is="MODE_ICONS[mode]" class="w-3.5 h-3.5 mr-1" />
              {{ MODE_LABELS[mode] }}
            </Button>
          </div>

          <Button
            data-testid="remote-connect-btn"
            class="w-full font-medium"
            size="sm"
            :disabled="!remoteAgentId.trim() || connectPending"
            @click="handleRemoteConnect"
          >
            <ExternalLink v-if="!connectPending" class="w-3.5 h-3.5 mr-1.5" />
            <span>{{ connectPending ? 'Connecting...' : 'Connect' }}</span>
          </Button>

          <Alert
            v-if="remoteError"
            data-testid="remote-error"
            variant="destructive"
          >
            <AlertDescription>{{ remoteError }}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>

    <!-- Bottom Section: My Devices -->
    <Card class="border-border/80 bg-card/95">
      <CardHeader class="pb-3">
        <CardTitle class="text-lg font-semibold flex items-center gap-2">
          <Laptop class="w-4 h-4 text-primary" />
          My Devices
        </CardTitle>
        <CardDescription class="text-xs text-muted-foreground">
          {{ store.devices.length }} device(s) registered
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div
          v-if="store.loading && store.devices.length === 0"
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
                  >{{ device.hostname }}</span
                >
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
                <Badge
                  v-if="device.id === localAgentId"
                  data-testid="device-local-badge"
                  variant="outline"
                  class="text-[11px] font-mono px-1.5 py-0 border-primary/40 text-primary"
                >
                  This device
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

            <div class="flex items-center gap-1.5 shrink-0">
              <Button
                data-testid="device-connect"
                variant="outline"
                size="sm"
                class="h-7 text-xs"
                :disabled="!device.isOnline || device.id === localAgentId"
                @click="handleDeviceConnect(device.id)"
              >
                <ExternalLink class="w-3 h-3" />
                Connect
              </Button>
              <Button
                data-testid="device-delete"
                variant="destructive"
                size="sm"
                class="h-7 text-xs"
                @click="handleDelete(device.id)"
              >
                <Trash2 class="w-3 h-3" />
              </Button>
            </div>
          </li>
        </ul>
      </CardContent>
    </Card>

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
          <AlertDialogAction
            data-slot="alert-dialog-action"
            @click="confirmDelete"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useFleetStore } from '@/stores/fleet';
import { apiClient } from '@/services/client';
import type { Device, Agent } from '@ponter/shared';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Server,
  Terminal,
  Laptop,
  Radio,
  RefreshCw,
  ShieldCheck,
  Search,
  ArrowUpRight,
  Activity,
  CheckCircle2,
  Lock,
  Plus,
  Pencil,
  Trash2,
  ChevronRight,
} from '@lucide/vue';
import { toast } from 'vue-sonner';
import RegisterAgentDialog from '@/components/agent/RegisterAgentDialog.vue';
import EditAgentDialog from '@/components/agent/EditAgentDialog.vue';
import DeleteAgentDialog from '@/components/agent/DeleteAgentDialog.vue';
import EncryptionByChannelDialog from '@/components/security/EncryptionByChannelDialog.vue';

const authStore = useAuthStore();
const router = useRouter();
const fleetStore = useFleetStore();
const devices = ref<Device[]>([]);
const agents = ref<Agent[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const searchQuery = ref('');
const statusFilter = ref<'all' | 'online' | 'offline'>('all');
const showRegisterModal = ref(false);
const editingAgent = ref<Agent | null>(null);
const deletingAgent = ref<Agent | null>(null);
const showSecurityDetails = ref(false);

let pollInterval: ReturnType<typeof setInterval> | null = null;
let unsubscribeFleet: (() => void) | null = null;

async function loadDashboardData(isBackground = false) {
  if (!isBackground) {
    loading.value = true;
  }
  error.value = null;
  try {
    const [devs, agts] = await Promise.all([
      apiClient.devices.list(),
      apiClient.agents.list(),
    ]);
    devices.value = devs;
    agents.value = agts;
  } catch (err) {
    if (!isBackground) {
      error.value =
        err instanceof Error ? err.message : 'Failed to load dashboard data';
    }
  } finally {
    if (!isBackground) {
      loading.value = false;
    }
  }
}

const onlineAgentsCount = computed(() => {
  return agents.value.filter((a) => a.isOnline).length;
});

const filteredAgents = computed(() => {
  return agents.value.filter((a) => {
    const matchesSearch =
      searchQuery.value === '' ||
      (a.hostname &&
        a.hostname.toLowerCase().includes(searchQuery.value.toLowerCase())) ||
      a.id.toLowerCase().includes(searchQuery.value.toLowerCase()) ||
      (a.platform &&
        a.platform.toLowerCase().includes(searchQuery.value.toLowerCase()));

    const matchesStatus =
      statusFilter.value === 'all' ||
      (statusFilter.value === 'online' && a.isOnline) ||
      (statusFilter.value === 'offline' && !a.isOnline);

    return matchesSearch && matchesStatus;
  });
});

function openEdit(agent: Agent) {
  editingAgent.value = agent;
}

function openDelete(agent: Agent) {
  deletingAgent.value = agent;
}

/** Swap the edited agent into the list so the card reflects the new metadata. */
function handleUpdated(updated: Agent) {
  agents.value = agents.value.map((a) => (a.id === updated.id ? updated : a));
  toast.success('Agent updated');
}

/** Drop the deleted agent from the list without a full refetch. */
function handleDeleted(id: string) {
  agents.value = agents.value.filter((a) => a.id !== id);
  toast.success('Agent deleted');
}

onMounted(() => {
  loadDashboardData();
  pollInterval = setInterval(() => {
    void loadDashboardData(true);
  }, 60000);
  unsubscribeFleet = fleetStore.subscribe(() => {
    void loadDashboardData(true);
  });
  fleetStore.start();
});

onUnmounted(() => {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  unsubscribeFleet?.();
  fleetStore.stop();
});
</script>

<template>
  <div class="container mx-auto px-4 sm:px-6 py-6 space-y-6">
    <!-- Top Welcome & Actions Header -->
    <div
      class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-border/80 pb-5"
    >
      <div>
        <div class="flex items-center gap-2">
          <h1 class="text-2xl sm:text-3xl font-bold tracking-tight">
            Command Center
          </h1>
          <Badge
            variant="outline"
            class="font-mono text-xs px-2 py-0.5 border-primary/30 text-primary"
          >
            v0.1.0
          </Badge>
        </div>
        <p class="text-xs sm:text-sm text-muted-foreground mt-1">
          Operator:
          <span class="font-medium text-foreground font-mono">{{
            authStore.user?.username
          }}</span>
          · High-Performance Remote Infrastructure
        </p>
      </div>
      <div class="flex items-center gap-2 w-full sm:w-auto">
        <Button
          variant="outline"
          size="sm"
          :disabled="loading"
          @click="loadDashboardData"
          class="flex items-center gap-1.5 flex-1 sm:flex-none text-xs"
        >
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loading }" />
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          class="flex items-center gap-1.5 flex-1 sm:flex-none text-xs"
          @click="showRegisterModal = true"
        >
          <Plus class="w-3.5 h-3.5 text-primary" />
          Register Agent
        </Button>
        <Button
          size="sm"
          @click="router.push('/workspace')"
          class="flex items-center gap-1.5 flex-1 sm:flex-none text-xs"
        >
          <Terminal class="w-3.5 h-3.5" />
          Open Workspace
        </Button>
      </div>
    </div>

    <!-- Error Alert -->
    <Alert
      v-if="error"
      variant="destructive"
      class="border-destructive/30 bg-destructive/10"
    >
      <AlertDescription class="flex justify-between items-center text-xs">
        <span>{{ error }}</span>
        <Button variant="outline" size="sm" @click="loadDashboardData"
          >Retry</Button
        >
      </AlertDescription>
    </Alert>

    <!-- Telemetry & Metrics Overview Row -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <Card class="border-border/80 bg-card/90 shadow-sm">
        <CardContent class="p-4 sm:p-5 flex items-center justify-between">
          <div class="space-y-1">
            <p class="text-xs font-medium text-muted-foreground">
              Fleet Status
            </p>
            <div class="flex items-baseline gap-2">
              <span class="text-2xl font-bold font-mono">{{
                onlineAgentsCount
              }}</span>
              <span class="text-xs text-muted-foreground font-mono"
                >/ {{ agents.length }} online</span
              >
            </div>
            <p class="text-[11px] text-muted-foreground">
              Direct WebRTC DataChannel Ready
            </p>
          </div>
          <div
            class="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary"
          >
            <Radio class="w-5 h-5" />
          </div>
        </CardContent>
      </Card>

      <Card class="border-border/80 bg-card/90 shadow-sm">
        <CardContent class="p-4 sm:p-5 flex items-center justify-between">
          <div class="space-y-1">
            <p class="text-xs font-medium text-muted-foreground">
              Authorized Devices
            </p>
            <div class="flex items-baseline gap-2">
              <span class="text-2xl font-bold font-mono">{{
                devices.length
              }}</span>
              <span class="text-xs text-muted-foreground font-mono"
                >devices bound</span
              >
            </div>
            <p class="text-[11px] text-muted-foreground">
              Hardware tokens & Web Crypto
            </p>
          </div>
          <div
            class="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary"
          >
            <Laptop class="w-5 h-5" />
          </div>
        </CardContent>
      </Card>

      <Card
        class="border-border/80 bg-card/90 shadow-sm sm:col-span-2 lg:col-span-1"
      >
        <CardContent class="p-4 sm:p-5 flex items-center justify-between">
          <div class="space-y-1">
            <p class="text-xs font-medium text-muted-foreground">
              Security Architecture
            </p>
            <div class="space-y-1">
              <div
                class="flex items-center gap-1.5 text-sm font-semibold text-primary"
              >
                <ShieldCheck class="w-4 h-4" />
                <span>E2EE: terminal & input</span>
              </div>
              <div
                class="flex items-center gap-1.5 text-sm font-medium text-muted-foreground"
              >
                <Lock class="w-4 h-4" />
                <span>DTLS/SRTP: video & files</span>
              </div>
            </div>
            <p class="text-[11px] text-muted-foreground">
              AES-GCM-256 app-layer · DTLS 1.2 transport
            </p>
            <button
              type="button"
              data-test="security-details-toggle"
              class="mt-1 inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              @click="showSecurityDetails = true"
            >
              Details
              <ChevronRight class="w-3 h-3" />
            </button>
          </div>
          <div
            class="w-10 h-10 rounded-lg bg-secondary border border-border flex items-center justify-center text-muted-foreground"
          >
            <Lock class="w-5 h-5 text-primary" />
          </div>
        </CardContent>
      </Card>
    </div>
    <!-- Main Grid: Fleet on Left, Devices & Security on Right -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Agent Fleet Section (2 Cols on lg) -->
      <div class="lg:col-span-2 space-y-4">
        <Card class="border-border/80 bg-card/95 shadow-sm">
          <CardHeader class="pb-3">
            <div
              class="flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div>
                <CardTitle class="text-lg font-bold flex items-center gap-2">
                  <Server class="w-4 h-4 text-primary" />
                  Remote Agents
                </CardTitle>
                <CardDescription class="text-xs text-muted-foreground mt-0.5">
                  Host daemon endpoints available for remote terminal & PTY
                  virtualization
                </CardDescription>
              </div>
              <!-- Status Filter Buttons -->
              <div
                class="flex items-center gap-1 bg-secondary/80 p-0.5 rounded-lg border border-border text-xs"
              >
                <button
                  type="button"
                  class="px-2.5 py-1 rounded-md font-medium transition-colors"
                  :class="
                    statusFilter === 'all'
                      ? 'bg-card text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  "
                  @click="statusFilter = 'all'"
                >
                  All ({{ agents.length }})
                </button>
                <button
                  type="button"
                  class="px-2.5 py-1 rounded-md font-medium transition-colors"
                  :class="
                    statusFilter === 'online'
                      ? 'bg-card text-success shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  "
                  @click="statusFilter = 'online'"
                >
                  Online ({{ onlineAgentsCount }})
                </button>
                <button
                  type="button"
                  class="px-2.5 py-1 rounded-md font-medium transition-colors"
                  :class="
                    statusFilter === 'offline'
                      ? 'bg-card text-muted-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  "
                  @click="statusFilter = 'offline'"
                >
                  Offline ({{ agents.length - onlineAgentsCount }})
                </button>
              </div>
            </div>

            <!-- Search input bar -->
            <div class="relative mt-3">
              <Search
                class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                v-model="searchQuery"
                type="text"
                placeholder="Filter by hostname, platform, or agent ID..."
                class="pl-9 h-9 text-xs font-mono bg-background/60"
              />
            </div>
          </CardHeader>

          <CardContent class="pt-0">
            <!-- Loading state -->
            <div v-if="loading" class="space-y-3 py-4">
              <div
                v-for="i in 3"
                :key="i"
                class="h-20 rounded-lg bg-muted/40 border border-border/50 motion-safe:animate-pulse"
              />
            </div>

            <!-- Empty state -->
            <div
              v-else-if="filteredAgents.length === 0"
              class="text-center py-12 px-4 border border-dashed border-border rounded-lg"
            >
              <Server
                class="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-50"
              />
              <p class="text-sm font-medium text-foreground">
                No agents match your criteria
              </p>
              <p class="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                {{
                  agents.length === 0
                    ? 'No agent daemons registered yet. Connect your native Rust agent via the agent setup runbook.'
                    : 'Try changing your search query or status filter.'
                }}
              </p>
              <div v-if="agents.length === 0" class="mt-4">
                <Button
                  size="sm"
                  class="gap-1.5 text-xs"
                  @click="showRegisterModal = true"
                >
                  <Plus class="w-3.5 h-3.5" />
                  Register Your First Agent
                </Button>
              </div>
            </div>

            <!-- Agent List Cards -->
            <div v-else class="space-y-2.5">
              <div
                v-for="a in filteredAgents"
                :key="a.id"
                class="group p-3.5 rounded-lg border border-border/80 bg-card hover:bg-accent/40 hover:border-primary/40 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div class="flex items-start gap-3">
                  <div
                    class="w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors"
                    :class="
                      a.isOnline
                        ? 'bg-success/10 text-success border border-success/20'
                        : 'bg-muted text-muted-foreground border border-border'
                    "
                  >
                    <Server class="w-4 h-4" />
                  </div>
                  <div class="space-y-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span
                        class="font-semibold text-sm tracking-tight text-foreground"
                      >
                        {{ a.hostname || 'Remote Host' }}
                      </span>
                      <Badge
                        :variant="a.isOnline ? 'default' : 'secondary'"
                        class="text-[10px] font-mono px-1.5 py-0"
                        :class="
                          a.isOnline
                            ? 'bg-success text-white dark:bg-success'
                            : ''
                        "
                      >
                        {{ a.isOnline ? 'ONLINE' : 'OFFLINE' }}
                      </Badge>
                      <Badge
                        variant="outline"
                        class="text-[10px] font-mono px-1.5 py-0 text-muted-foreground"
                      >
                        {{ a.platform || 'Linux' }}
                      </Badge>
                    </div>
                    <p
                      class="text-xs font-mono text-muted-foreground flex items-center gap-1.5"
                    >
                      <span>ID:</span>
                      <span class="text-foreground/80">{{ a.id }}</span>
                    </p>
                  </div>
                </div>

                <div class="flex items-center gap-2 self-end sm:self-center">
                  <Button
                    v-if="a.isOnline"
                    size="sm"
                    class="h-8 px-3 text-xs font-medium flex items-center gap-1.5 shadow-xs"
                    @click.stop="
                      router.push({
                        name: 'workspace',
                        params: { agentId: a.id },
                      })
                    "
                  >
                    <Terminal class="w-3.5 h-3.5" />
                    Launch Shell
                    <ArrowUpRight class="w-3 h-3 opacity-70" />
                  </Button>
                  <Button
                    v-else
                    variant="outline"
                    size="sm"
                    disabled
                    class="h-8 px-3 text-xs opacity-60"
                  >
                    Agent Offline
                  </Button>

                  <!-- Manage actions: edit metadata and remove the agent from
                       the fleet. Kept here on the dashboard, not in the
                       workspace, so fleet administration lives in one place. -->
                  <div
                    class="flex items-center gap-0.5 pl-1.5 ml-0.5 border-l border-border/70"
                  >
                    <button
                      type="button"
                      class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      title="Edit agent"
                      :aria-label="`Edit ${a.hostname || a.id}`"
                      :data-test="`edit-agent-${a.id}`"
                      @click.stop="openEdit(a)"
                    >
                      <Pencil class="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      class="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      title="Delete agent"
                      :aria-label="`Delete ${a.hostname || a.id}`"
                      :data-test="`delete-agent-${a.id}`"
                      @click.stop="openDelete(a)"
                    >
                      <Trash2 class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <!-- Right Column: Registered Devices & Security Info -->
      <div class="space-y-6">
        <!-- Devices Card -->
        <Card class="border-border/80 bg-card/95 shadow-sm">
          <CardHeader class="pb-3">
            <div class="flex items-center justify-between">
              <div>
                <CardTitle class="text-base font-bold flex items-center gap-2">
                  <Laptop class="w-4 h-4 text-primary" />
                  Registered Devices
                </CardTitle>
                <CardDescription class="text-xs text-muted-foreground mt-0.5">
                  Authorized clients & hardware tokens
                </CardDescription>
              </div>
              <Badge variant="secondary" class="font-mono text-xs">{{
                devices.length
              }}</Badge>
            </div>
          </CardHeader>
          <CardContent class="pt-0">
            <div
              v-if="devices.length === 0"
              class="text-center py-8 text-muted-foreground text-xs"
            >
              No devices registered yet.
            </div>
            <div v-else class="space-y-2">
              <div
                v-for="d in devices"
                :key="d.id"
                class="p-2.5 rounded-lg border border-border/70 bg-card hover:bg-muted/40 transition-colors flex items-center justify-between gap-2"
              >
                <div class="space-y-0.5 truncate">
                  <p class="font-medium text-xs truncate">
                    {{ d.deviceName || 'Authorized Browser' }}
                  </p>
                  <p
                    class="text-[11px] text-muted-foreground font-mono truncate"
                  >
                    {{ d.fingerprint.slice(0, 18) }}...
                  </p>
                </div>
                <Badge
                  :variant="d.isTrusted ? 'default' : 'outline'"
                  class="text-[10px] font-mono px-1.5 py-0 flex-shrink-0"
                >
                  {{ d.deviceType }}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- DTLS-Secured Transport Insight Card -->
        <Card class="border-border/80 bg-secondary/30 shadow-sm">
          <CardHeader class="pb-2">
            <CardTitle
              class="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"
            >
              <Activity class="w-3.5 h-3.5 text-primary" />
              Direct P2P Connectivity
            </CardTitle>
          </CardHeader>
          <CardContent class="text-xs text-muted-foreground space-y-2 pt-0">
            <p>
              Terminal sessions stream directly between browser and host via
              WebRTC DataChannels with DTLS 1.2 encryption.
            </p>
            <div class="space-y-1.5 pt-1 text-[11px] font-mono">
              <div class="flex items-center gap-2">
                <CheckCircle2 class="w-3.5 h-3.5 text-primary" />
                <span>Signaling: Self-hosted Node.js Server</span>
              </div>
              <div class="flex items-center gap-2">
                <CheckCircle2 class="w-3.5 h-3.5 text-primary" />
                <span>Transport: P2P SCTP / DTLS 1.2</span>
              </div>
              <div class="flex items-center gap-2">
                <CheckCircle2 class="w-3.5 h-3.5 text-primary" />
                <span>Application-layer E2EE: terminal & input channels</span>
              </div>
              <div class="flex items-center gap-2">
                <CheckCircle2 class="w-3.5 h-3.5 text-primary" />
                <span>PTY: RingBuffer 64 KiB Virtualization</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>

    <!-- Agent Registration Dialog -->
    <RegisterAgentDialog
      v-model:open="showRegisterModal"
      @registered="loadDashboardData"
    />

    <!-- Agent Management Dialogs -->
    <EditAgentDialog
      :open="editingAgent !== null"
      :agent="editingAgent"
      @update:open="(v) => !v && (editingAgent = null)"
      @updated="handleUpdated"
    />
    <DeleteAgentDialog
      :open="deletingAgent !== null"
      :agent="deletingAgent"
      @update:open="(v) => !v && (deletingAgent = null)"
      @deleted="handleDeleted"
    />

    <EncryptionByChannelDialog
      :open="showSecurityDetails"
      @update:open="showSecurityDetails = $event"
    />
  </div>
</template>

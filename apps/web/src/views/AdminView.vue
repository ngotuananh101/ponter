<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { apiClient } from '@/services/client';
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
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  ShieldCheck,
  Users,
  Settings,
  Server,
  Activity,
  Search,
  RefreshCw,
  CheckCircle2,
  Shield,
  ShieldOff,
  UserCheck,
  UserX,
  Ban,
  Unlock,
} from '@lucide/vue';
import type {
  SystemStats,
  SystemSettings,
  User,
  ApprovalStatus,
  UserRole,
} from '@ponter/shared';
import { isApiError } from '@ponter/api-client';

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected' | 'inactive';
type Tab = 'overview' | 'users' | 'settings';

const activeTab = ref<Tab>('overview');
const stats = ref<SystemStats | null>(null);
const users = ref<User[]>([]);
const totalUsers = ref<number>(0);
const settings = ref<SystemSettings | null>(null);

const overviewLoading = ref(true);
const usersLoading = ref(true);
const settingsLoading = ref(true);

const overviewError = ref<string | null>(null);
const usersError = ref<string | null>(null);
const settingsError = ref<string | null>(null);

const notice = ref<string | null>(null);
const noticeType = ref<'success' | 'error'>('success');

const searchQuery = ref('');
const statusFilter = ref<StatusFilter>('all');

function clearNotice() {
  notice.value = null;
}

async function loadOverview() {
  overviewLoading.value = true;
  overviewError.value = null;
  try {
    stats.value = await apiClient.admin.getStats();
  } catch (err) {
    overviewError.value =
      err instanceof Error ? err.message : 'Failed to load overview';
  } finally {
    overviewLoading.value = false;
  }
}

async function loadUsers() {
  usersLoading.value = true;
  usersError.value = null;
  try {
    const params: Record<string, string | number | undefined> = {};
    if (statusFilter.value !== 'all') {
      params.status = statusFilter.value;
    }
    if (searchQuery.value.trim()) {
      params.search = searchQuery.value.trim();
    }
    const res = await apiClient.admin.getUsers(params);
    users.value = res.users;
    totalUsers.value = res.total;
  } catch (err) {
    usersError.value =
      err instanceof Error ? err.message : 'Failed to load users';
  } finally {
    usersLoading.value = false;
  }
}

async function loadSettings() {
  settingsLoading.value = true;
  settingsError.value = null;
  try {
    settings.value = await apiClient.admin.getSettings();
  } catch (err) {
    settingsError.value =
      err instanceof Error ? err.message : 'Failed to load settings';
  } finally {
    settingsLoading.value = false;
  }
}

async function refreshTab() {
  if (activeTab.value === 'overview') {
    await loadOverview();
  } else if (activeTab.value === 'users') {
    await loadUsers();
  } else if (activeTab.value === 'settings') {
    await loadSettings();
  }
}

async function handleUserAction(
  id: string,
  payload: {
    approvalStatus?: ApprovalStatus;
    isActive?: boolean;
    role?: UserRole;
  },
  successMsg: string,
) {
  notice.value = null;
  try {
    await apiClient.admin.updateUser(id, payload);
    noticeType.value = 'success';
    notice.value = successMsg;
    // Re-fetch affected data
    await Promise.all([loadUsers(), loadOverview()]);
  } catch (err) {
    noticeType.value = 'error';
    if (isApiError(err)) {
      notice.value = err.message;
    } else if (err instanceof Error) {
      notice.value = err.message;
    } else {
      notice.value = 'An unexpected error occurred';
    }
  }
}

async function approve(id: string) {
  await handleUserAction(id, { approvalStatus: 'approved' }, 'User approved');
}

async function reject(id: string) {
  await handleUserAction(id, { approvalStatus: 'rejected' }, 'User rejected');
}

function promote(id: string) {
  void handleUserAction(id, { role: 'admin' }, 'User promoted to admin');
}

function demote(id: string) {
  if (!confirm('Are you sure you want to demote this admin?')) {
    return;
  }
  void handleUserAction(id, { role: 'user' }, 'Admin demoted');
}

function activate(id: string) {
  void handleUserAction(id, { isActive: true }, 'User activated');
}

function deactivate(id: string) {
  if (!confirm('Are you sure you want to deactivate this user?')) {
    return;
  }
  void handleUserAction(id, { isActive: false }, 'User deactivated');
}

async function saveSettings() {
  if (!settings.value) return;
  notice.value = null;
  try {
    await apiClient.admin.updateSettings(settings.value);
    noticeType.value = 'success';
    notice.value = 'Settings saved';
    await loadSettings();
  } catch (err) {
    noticeType.value = 'error';
    if (isApiError(err)) {
      notice.value = err.message;
    } else if (err instanceof Error) {
      notice.value = err.message;
    } else {
      notice.value = 'Failed to save settings';
    }
  }
}

const roleLabel = (u: User) => (u.role === 'admin' ? 'Admin' : 'User');

const statusBadgeVariant = (status: string) => {
  if (status === 'approved') return 'default';
  if (status === 'rejected') return 'destructive';
  return 'secondary';
};

onMounted(() => {
  loadOverview();
  loadUsers();
  loadSettings();
});
</script>

<template>
  <div class="container mx-auto px-4 sm:px-6 py-6 space-y-6">
    <div
      class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4"
    >
      <div>
        <div class="flex items-center gap-2">
          <h1 class="text-2xl sm:text-3xl font-bold tracking-tight">
            Administration Cockpit
          </h1>
          <Badge
            variant="outline"
            class="font-mono text-xs px-2 py-0.5 border-primary/30 text-primary"
          >
            <ShieldCheck class="w-3.5 h-3.5 mr-1" />
            admin
          </Badge>
        </div>
        <p class="text-xs sm:text-sm text-muted-foreground mt-1">
          System management and user administration
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          :disabled="overviewLoading || usersLoading || settingsLoading"
          @click="refreshTab"
          class="flex items-center gap-1.5 text-xs"
        >
          <RefreshCw class="w-3.5 h-3.5" />
          Refresh
        </Button>
      </div>
    </div>

    <!-- Notice Alert -->
    <Alert
      v-if="notice"
      :variant="noticeType === 'error' ? 'destructive' : 'default'"
      class="border-border/30"
    >
      <AlertDescription
        class="text-xs font-medium flex justify-between items-center"
      >
        <span>{{ notice }}</span>
        <Button variant="ghost" size="sm" @click="clearNotice">×</Button>
      </AlertDescription>
    </Alert>

    <!-- Tab Navigation -->
    <div
      class="flex items-center gap-1 bg-secondary/80 p-0.5 rounded-lg border border-border text-xs"
    >
      <button
        type="button"
        data-test="tab-overview"
        class="px-3 py-1.5 rounded-md font-medium transition-all"
        :class="
          activeTab === 'overview'
            ? 'bg-card text-foreground shadow-xs'
            : 'text-muted-foreground hover:text-foreground'
        "
        @click="activeTab = 'overview'"
      >
        <Activity class="w-3.5 h-3.5 mr-1 inline" />
        Overview
      </button>
      <button
        type="button"
        data-test="tab-users"
        class="px-3 py-1.5 rounded-md font-medium transition-all"
        :class="
          activeTab === 'users'
            ? 'bg-card text-foreground shadow-xs'
            : 'text-muted-foreground hover:text-foreground'
        "
        @click="activeTab = 'users'"
      >
        <Users class="w-3.5 h-3.5 mr-1 inline" />
        Users
      </button>
      <button
        type="button"
        data-test="tab-settings"
        class="px-3 py-1.5 rounded-md font-medium transition-all"
        :class="
          activeTab === 'settings'
            ? 'bg-card text-foreground shadow-xs'
            : 'text-muted-foreground hover:text-foreground'
        "
        @click="activeTab = 'settings'"
      >
        <Settings class="w-3.5 h-3.5 mr-1 inline" />
        Settings
      </button>
    </div>

    <!-- Overview Tab -->
    <div v-show="activeTab === 'overview'">
      <div v-if="overviewLoading">
        <p class="text-sm text-muted-foreground">Loading overview...</p>
      </div>

      <Alert
        v-else-if="overviewError"
        variant="destructive"
        class="border-destructive/30 bg-destructive/10"
      >
        <AlertDescription class="flex justify-between items-center text-xs">
          <span>{{ overviewError }}</span>
          <Button
            variant="outline"
            size="sm"
            data-test="btn-retry-overview"
            @click="loadOverview"
            >Retry</Button
          >
        </AlertDescription>
      </Alert>

      <div v-else-if="stats" class="space-y-6">
        <h2 class="text-xl font-bold tracking-tight">System Overview</h2>

        <!-- User Stats -->
        <Card class="border-border/80 bg-card/95 shadow-sm">
          <CardHeader class="pb-3">
            <CardTitle class="text-base font-bold flex items-center gap-2">
              <Users class="w-4 h-4 text-primary" />
              User Statistics
            </CardTitle>
            <CardDescription class="text-xs text-muted-foreground">
              Total registered accounts and approval status
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div
              class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4 text-center"
            >
              <div>
                <p class="text-2xl font-bold font-mono">
                  {{ stats.users.total }}
                </p>
                <p class="text-xs text-muted-foreground">Total</p>
              </div>
              <div>
                <p
                  class="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400"
                >
                  {{ stats.users.approved }}
                </p>
                <p class="text-xs text-muted-foreground">Approved</p>
              </div>
              <div>
                <p
                  class="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400"
                >
                  {{ stats.users.pending }}
                </p>
                <p class="text-xs text-muted-foreground">Pending</p>
              </div>
              <div>
                <p
                  class="text-2xl font-bold font-mono text-red-600 dark:text-red-400"
                >
                  {{ stats.users.rejected }}
                </p>
                <p class="text-xs text-muted-foreground">Rejected</p>
              </div>
              <div>
                <p class="text-2xl font-bold font-mono text-primary">
                  {{ stats.users.admins }}
                </p>
                <p class="text-xs text-muted-foreground">Admins</p>
              </div>
            </div>

            <Alert
              v-if="stats.users.pending > 0"
              variant="default"
              class="mt-4 border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/30"
            >
              <AlertDescription
                class="text-xs text-amber-800 dark:text-amber-200 flex items-center gap-2"
              >
                <Activity class="w-4 h-4" />
                There are
                <strong>{{ stats.users.pending }}</strong>
                pending user registrations awaiting approval.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <!-- Agent Stats -->
        <Card class="border-border/80 bg-card/95 shadow-sm">
          <CardHeader class="pb-3">
            <CardTitle class="text-base font-bold flex items-center gap-2">
              <Server class="w-4 h-4 text-primary" />
              Agent Statistics
            </CardTitle>
            <CardDescription class="text-xs text-muted-foreground">
              Connected remote agents and platform distribution
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-4 text-center">
              <div>
                <p class="text-2xl font-bold font-mono">
                  {{ stats.agents.total }}
                </p>
                <p class="text-xs text-muted-foreground">Total Agents</p>
              </div>
              <div>
                <p
                  class="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400"
                >
                  {{ stats.agents.online }}
                </p>
                <p class="text-xs text-muted-foreground">Online</p>
              </div>
              <div>
                <p class="text-2xl font-bold font-mono">
                  {{ stats.agents.total - stats.agents.online }}
                </p>
                <p class="text-xs text-muted-foreground">Offline</p>
              </div>
            </div>

            <div
              v-if="Object.keys(stats.agents.byPlatform).length > 0"
              class="mt-4 flex flex-wrap gap-2"
            >
              <Badge
                v-for="(count, platform) in stats.agents.byPlatform"
                :key="platform"
                variant="outline"
                class="text-xs font-mono"
              >
                {{ platform }}: {{ count }}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <!-- Session Stats -->
        <Card class="border-border/80 bg-card/95 shadow-sm">
          <CardHeader class="pb-3">
            <CardTitle class="text-base font-bold flex items-center gap-2">
              <Activity class="w-4 h-4 text-primary" />
              Active Sessions
            </CardTitle>
            <CardDescription class="text-xs text-muted-foreground">
              Currently open terminal and desktop sessions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-4 text-center">
              <div>
                <p class="text-2xl font-bold font-mono">
                  {{ stats.sessions.active }}
                </p>
                <p class="text-xs text-muted-foreground">Active Sessions</p>
              </div>
              <div>
                <p class="text-2xl font-bold font-mono text-primary">
                  {{ stats.sessions.byKind.terminal }}
                </p>
                <p class="text-xs text-muted-foreground">Terminal</p>
              </div>
              <div>
                <p class="text-2xl font-bold font-mono text-primary">
                  {{ stats.sessions.byKind.desktop }}
                </p>
                <p class="text-xs text-muted-foreground">Desktop</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>

    <!-- Users Tab -->
    <div v-show="activeTab === 'users'" class="space-y-4">
      <div class="flex flex-col sm:flex-row gap-4 items-start sm:items-end">
        <div class="relative flex-1">
          <Search
            class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            v-model="searchQuery"
            type="text"
            placeholder="Search by username or email..."
            class="pl-9 h-9 text-xs font-mono bg-background/60"
            @input="loadUsers"
          />
        </div>

        <div
          class="flex items-center gap-1 bg-secondary/80 p-0.5 rounded-lg border border-border text-xs"
        >
          <button
            type="button"
            class="px-2.5 py-1 rounded-md font-medium transition-all"
            :class="
              statusFilter === 'all'
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            "
            @click="
              statusFilter = 'all';
              loadUsers();
            "
          >
            All ({{ totalUsers }})
          </button>
          <button
            type="button"
            class="px-2.5 py-1 rounded-md font-medium transition-all"
            :class="
              statusFilter === 'pending'
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            "
            @click="
              statusFilter = 'pending';
              loadUsers();
            "
          >
            Pending
          </button>
          <button
            type="button"
            class="px-2.5 py-1 rounded-md font-medium transition-all"
            :class="
              statusFilter === 'approved'
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            "
            @click="
              statusFilter = 'approved';
              loadUsers();
            "
          >
            Approved
          </button>
          <button
            type="button"
            class="px-2.5 py-1 rounded-md font-medium transition-all"
            :class="
              statusFilter === 'rejected'
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            "
            @click="
              statusFilter = 'rejected';
              loadUsers();
            "
          >
            Rejected
          </button>
          <button
            type="button"
            class="px-2.5 py-1 rounded-md font-medium transition-all"
            :class="
              statusFilter === 'inactive'
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            "
            @click="
              statusFilter = 'inactive';
              loadUsers();
            "
          >
            Inactive
          </button>
        </div>
      </div>

      <Alert
        v-if="usersError"
        variant="destructive"
        class="border-destructive/30 bg-destructive/10"
      >
        <AlertDescription class="flex justify-between items-center text-xs">
          <span>{{ usersError }}</span>
          <Button variant="outline" size="sm" @click="loadUsers">Retry</Button>
        </AlertDescription>
      </Alert>

      <div v-else-if="usersLoading" class="space-y-2 py-4">
        <p class="text-sm text-muted-foreground">Loading users...</p>
      </div>

      <div
        v-else-if="users.length === 0"
        class="text-center py-12 px-4 border border-dashed border-border rounded-lg"
      >
        <Users class="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-50" />
        <p class="text-sm font-medium text-foreground">No users found</p>
        <p class="text-xs text-muted-foreground mt-1">
          {{
            statusFilter !== 'all'
              ? 'Try changing your search or status filter.'
              : 'No users registered yet.'
          }}
        </p>
      </div>

      <div v-else class="space-y-2">
        <div
          v-for="u in users"
          :key="u.id"
          class="group p-3.5 rounded-lg border border-border/80 bg-card hover:bg-accent/40 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div class="flex items-start gap-3 flex-1 min-w-0">
            <div
              class="w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5 border border-border"
              :class="
                u.role === 'admin'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-secondary text-muted-foreground'
              "
            >
              <Shield class="w-4 h-4" />
            </div>
            <div class="space-y-1 min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span
                  class="font-semibold text-sm tracking-tight text-foreground truncate"
                >
                  {{ u.username }}
                </span>
                <Badge
                  :variant="statusBadgeVariant(u.approvalStatus)"
                  class="text-[10px] font-mono"
                >
                  {{ u.approvalStatus }}
                </Badge>
                <Badge
                  variant="outline"
                  class="text-[10px] font-mono px-1.5 py-0 text-muted-foreground"
                  >{{ roleLabel(u) }}
                </Badge>
                <Badge
                  :variant="u.isActive ? 'default' : 'secondary'"
                  class="text-[10px] font-mono"
                >
                  {{ u.isActive ? 'Active' : 'Inactive' }}
                </Badge>
              </div>
              <p
                v-if="u.email"
                class="text-xs font-mono text-muted-foreground truncate"
              >
                {{ u.email }}
              </p>
              <p class="text-[11px] text-muted-foreground">
                Created {{ new Date(u.createdAt).toLocaleDateString() }}
              </p>
            </div>
          </div>

          <div
            class="flex items-center gap-0.5 pl-1.5 ml-0.5 border-l border-border/70 flex-wrap gap-y-1"
          >
            <!-- Approval actions -->
            <button
              v-if="u.approvalStatus === 'pending'"
              type="button"
              :data-test="`btn-approve-${u.id}`"
              class="p-1.5 rounded-md text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
              title="Approve user"
              @click="approve(u.id)"
            >
              <UserCheck class="w-3.5 h-3.5" />
            </button>
            <button
              v-if="u.approvalStatus !== 'approved'"
              type="button"
              :data-test="`btn-reject-${u.id}`"
              class="p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
              title="Reject user"
              @click="reject(u.id)"
            >
              <UserX class="w-3.5 h-3.5" />
            </button>

            <!-- Role actions -->
            <button
              v-if="u.role === 'user'"
              type="button"
              :data-test="`btn-promote-${u.id}`"
              class="p-1.5 rounded-md text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 transition-colors"
              title="Promote to admin"
              @click="promote(u.id)"
            >
              <Shield class="w-3.5 h-3.5" />
            </button>
            <button
              v-else
              type="button"
              :data-test="`btn-demote-${u.id}`"
              class="p-1.5 rounded-md text-slate-600 dark:text-slate-400 hover:bg-slate-500/10 transition-colors"
              title="Demote admin"
              @click="demote(u.id)"
            >
              <ShieldOff class="w-3.5 h-3.5" />
            </button>

            <!-- Active actions -->
            <button
              v-if="u.isActive"
              type="button"
              :data-test="`btn-deactivate-${u.id}`"
              class="p-1.5 rounded-md text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition-colors"
              title="Deactivate user"
              @click="deactivate(u.id)"
            >
              <Ban class="w-3.5 h-3.5" />
            </button>
            <button
              v-else
              type="button"
              :data-test="`btn-activate-${u.id}`"
              class="p-1.5 rounded-md text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
              title="Activate user"
              @click="activate(u.id)"
            >
              <Unlock class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Settings Tab -->
    <div v-show="activeTab === 'settings'" class="space-y-4">
      <Alert
        v-if="settingsError"
        variant="destructive"
        class="border-destructive/30 bg-destructive/10"
      >
        <AlertDescription class="flex justify-between items-center text-xs">
          <span>{{ settingsError }}</span>
          <Button variant="outline" size="sm" @click="loadSettings"
            >Retry</Button
          >
        </AlertDescription>
      </Alert>

      <div v-else-if="settingsLoading">
        <p class="text-sm text-muted-foreground">Loading settings...</p>
      </div>

      <Card v-else-if="settings" class="border-border/80 bg-card/95 shadow-sm">
        <CardHeader class="pb-3">
          <CardTitle class="text-base font-bold flex items-center gap-2">
            <Settings class="w-4 h-4 text-primary" />
            System Settings
          </CardTitle>
          <CardDescription class="text-xs text-muted-foreground">
            Configure registration and agent limits
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="space-y-2">
            <Label
              class="text-xs font-medium text-foreground flex items-center gap-1.5"
              >Allow Registration
            </Label>
            <div class="flex items-center gap-3">
              <input
                id="settings-allow-registration"
                data-test="settings-allow-registration"
                type="checkbox"
                :checked="settings.allowRegistration"
                @change="
                  settings.allowRegistration = (
                    $event.target as HTMLInputElement
                  ).checked
                "
                class="w-4 h-4 rounded border-border text-primary focus:ring-primary"
              />
              <Label
                for="settings-allow-registration"
                class="text-xs text-muted-foreground"
                >When disabled, new users cannot register.</Label
              >
            </div>
          </div>

          <div class="space-y-2">
            <Label
              class="text-xs font-medium text-foreground flex items-center gap-1.5"
              >Auto-approve Users
            </Label>
            <div class="flex items-center gap-3">
              <input
                id="settings-auto-approve"
                data-test="settings-auto-approve"
                type="checkbox"
                :checked="settings.autoApproveUsers"
                @change="
                  settings.autoApproveUsers = (
                    $event.target as HTMLInputElement
                  ).checked
                "
                class="w-4 h-4 rounded border-border text-primary focus:ring-primary"
              />
              <Label
                for="settings-auto-approve"
                class="text-xs text-muted-foreground"
                >When enabled, new users are approved automatically.</Label
              >
            </div>
          </div>

          <div class="space-y-2">
            <Label
              class="text-xs font-medium text-foreground flex items-center gap-1.5"
              >Max Agents per User
            </Label>
            <Input
              id="settings-max-agents"
              data-test="settings-max-agents"
              type="number"
              min="1"
              :value="settings.maxAgentsPerUser"
              @input="
                settings.maxAgentsPerUser =
                  parseInt(($event.target as HTMLInputElement).value, 10) || 0
              "
              class="w-32 bg-background/60 font-mono text-sm focus-visible:ring-primary"
            />
            <p class="text-[11px] text-muted-foreground">
              Maximum number of agents a single user may register.
            </p>
          </div>
        </CardContent>
        <div class="px-6 pb-4 flex justify-end">
          <Button
            data-test="btn-save-settings"
            size="sm"
            class="flex items-center gap-1.5 text-xs"
            @click="saveSettings"
          >
            <CheckCircle2 class="w-3.5 h-3.5" />
            Save Settings
          </Button>
        </div>
      </Card>
    </div>
  </div>
</template>

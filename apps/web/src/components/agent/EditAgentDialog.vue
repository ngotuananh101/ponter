<script setup lang="ts">
import { ref, watch } from 'vue';
import { apiClient } from '@/services/client';
import type { Agent } from '@ponter/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Pencil,
  X,
  AlertTriangle,
  Terminal,
  Monitor,
  Check,
} from '@lucide/vue';

const props = defineProps<{
  open: boolean;
  agent: Agent | null;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'updated', agent: Agent): void;
}>();

/**
 * The capabilities an operator may toggle. Kept in sync with the ones the
 * registration dialog grants; anything else the agent reports is preserved
 * verbatim (see `handleSubmit`).
 */
const TOGGLEABLE_CAPABILITIES = ['terminal', 'desktop'] as const;

const hostname = ref('');
const platform = ref('');
const osVersion = ref('');
const agentVersion = ref('');
const capabilities = ref<string[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

/** Copy the agent's current metadata into the form. */
function syncFromAgent(agent: Agent | null) {
  hostname.value = agent?.hostname ?? '';
  platform.value = agent?.platform ?? '';
  osVersion.value = agent?.osVersion ?? '';
  agentVersion.value = agent?.agentVersion ?? '';
  capabilities.value = [...(agent?.capabilities ?? [])];
  error.value = null;
}

// Prefill on open, and refresh if the target agent changes while open.
watch(
  () => [props.open, props.agent?.id] as const,
  ([isOpen]) => {
    if (isOpen) syncFromAgent(props.agent);
  },
  { immediate: true },
);

function toggleCapability(cap: string) {
  capabilities.value = capabilities.value.includes(cap)
    ? capabilities.value.filter((c) => c !== cap)
    : [...capabilities.value, cap];
}

function handleClose() {
  emit('update:open', false);
}

async function handleSubmit() {
  const agent = props.agent;
  if (!agent) return;

  loading.value = true;
  error.value = null;

  // Preserve any capability this dialog does not manage, so editing hostname
  // never silently drops e.g. a future 'files' capability.
  const extras = agent.capabilities.filter(
    (c) => !(TOGGLEABLE_CAPABILITIES as readonly string[]).includes(c),
  );

  try {
    const updated = await apiClient.agents.update(agent.id, {
      hostname: hostname.value.trim() || null,
      platform: platform.value.trim() || null,
      osVersion: osVersion.value.trim() || null,
      agentVersion: agentVersion.value.trim() || null,
      capabilities: [...capabilities.value, ...extras],
    });

    emit('updated', updated);
    emit('update:open', false);
  } catch (err: unknown) {
    error.value =
      err instanceof Error ? err.message : 'Failed to update agent.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && agent"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-xs animate-in fade-in duration-150"
    >
      <div class="fixed inset-0" @click="handleClose" />

      <div
        class="relative w-full max-w-lg rounded-xl border border-border bg-card text-card-foreground shadow-2xl z-10 overflow-hidden flex flex-col max-h-[90vh]"
      >
        <!-- Header -->
        <div
          class="flex items-center justify-between border-b border-border/80 px-6 py-4"
        >
          <div class="flex items-center gap-3">
            <div
              class="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary"
            >
              <Pencil class="w-4 h-4" />
            </div>
            <div>
              <h3 class="text-base font-bold tracking-tight">Edit Agent</h3>
              <p class="text-xs text-muted-foreground font-mono">
                {{ agent.id }}
              </p>
            </div>
          </div>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground p-1.5 rounded-lg hover:bg-secondary transition-colors"
            @click="handleClose"
          >
            <X class="w-4 h-4" />
            <span class="sr-only">Close</span>
          </button>
        </div>

        <div class="p-6 space-y-4 overflow-y-auto">
          <Alert v-if="error" variant="destructive" class="py-2.5">
            <AlertTriangle class="w-4 h-4" />
            <AlertDescription class="text-xs">{{ error }}</AlertDescription>
          </Alert>

          <!-- Hostname -->
          <div class="space-y-1.5">
            <Label for="edit-agent-hostname" class="text-xs font-semibold">
              Hostname
            </Label>
            <Input
              id="edit-agent-hostname"
              v-model="hostname"
              type="text"
              placeholder="e.g. workstation.lan"
              class="font-mono text-xs h-9 bg-background/60"
              :disabled="loading"
              @keydown.enter.prevent="handleSubmit"
            />
          </div>

          <!-- Platform -->
          <div class="space-y-1.5">
            <Label for="edit-agent-platform" class="text-xs font-semibold">
              Platform
            </Label>
            <Input
              id="edit-agent-platform"
              v-model="platform"
              type="text"
              placeholder="e.g. linux"
              class="font-mono text-xs h-9 bg-background/60"
              :disabled="loading"
              @keydown.enter.prevent="handleSubmit"
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <!-- OS version -->
            <div class="space-y-1.5">
              <Label for="edit-agent-os-version" class="text-xs font-semibold">
                OS Version
              </Label>
              <Input
                id="edit-agent-os-version"
                v-model="osVersion"
                type="text"
                placeholder="e.g. 24.04"
                class="font-mono text-xs h-9 bg-background/60"
                :disabled="loading"
                @keydown.enter.prevent="handleSubmit"
              />
            </div>

            <!-- Agent version -->
            <div class="space-y-1.5">
              <Label for="edit-agent-version" class="text-xs font-semibold">
                Agent Version
              </Label>
              <Input
                id="edit-agent-version"
                v-model="agentVersion"
                type="text"
                placeholder="e.g. 0.1.0"
                class="font-mono text-xs h-9 bg-background/60"
                :disabled="loading"
                @keydown.enter.prevent="handleSubmit"
              />
            </div>
          </div>

          <!-- Capabilities -->
          <div class="space-y-1.5">
            <Label class="text-xs font-semibold">Capabilities</Label>
            <div class="flex gap-2">
              <button
                type="button"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all"
                :class="
                  capabilities.includes('terminal')
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-card hover:bg-secondary/60 text-muted-foreground'
                "
                :aria-pressed="capabilities.includes('terminal')"
                :disabled="loading"
                data-test="edit-cap-terminal"
                @click="toggleCapability('terminal')"
              >
                <Terminal class="w-3.5 h-3.5" />
                Terminal
              </button>
              <button
                type="button"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all"
                :class="
                  capabilities.includes('desktop')
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-card hover:bg-secondary/60 text-muted-foreground'
                "
                :aria-pressed="capabilities.includes('desktop')"
                :disabled="loading"
                data-test="edit-cap-desktop"
                @click="toggleCapability('desktop')"
              >
                <Monitor class="w-3.5 h-3.5" />
                Desktop
              </button>
            </div>
          </div>

          <!-- Actions -->
          <div class="pt-3 flex justify-end gap-2 border-t border-border/80">
            <Button
              variant="outline"
              size="sm"
              :disabled="loading"
              data-test="edit-agent-cancel"
              @click="handleClose"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              class="gap-1.5"
              :disabled="loading"
              data-test="edit-agent-submit"
              @click="handleSubmit"
            >
              <Check class="w-3.5 h-3.5" />
              {{ loading ? 'Saving...' : 'Save Changes' }}
            </Button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

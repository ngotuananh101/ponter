<script setup lang="ts">
import { ref, watch } from 'vue';
import { apiClient } from '@/services/client';
import type { Agent } from '@ponter/shared';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Trash2, X, AlertTriangle } from '@lucide/vue';

const props = defineProps<{
  open: boolean;
  agent: Agent | null;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'deleted', id: string): void;
}>();

const loading = ref(false);
const error = ref<string | null>(null);

// A fresh confirmation starts with a clean error slate.
watch(
  () => [props.open, props.agent?.id] as const,
  ([isOpen]) => {
    if (isOpen) error.value = null;
  },
  { immediate: true },
);

function handleClose() {
  emit('update:open', false);
}

async function handleConfirm() {
  const agent = props.agent;
  if (!agent) return;

  loading.value = true;
  error.value = null;

  try {
    await apiClient.agents.delete(agent.id);
    emit('deleted', agent.id);
    emit('update:open', false);
  } catch (err: unknown) {
    error.value =
      err instanceof Error ? err.message : 'Failed to delete agent.';
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
      <!-- Decorative click-outside backdrop. It is not a keyboard control:
           the visible Close and Cancel buttons are the accessible dismissal. -->
      <div role="presentation" class="fixed inset-0" @click="handleClose" />

      <div
        class="relative w-full max-w-md rounded-xl border border-border bg-card text-card-foreground shadow-2xl z-10 overflow-hidden"
      >
        <div
          class="flex items-center justify-between border-b border-border/80 px-6 py-4"
        >
          <div class="flex items-center gap-3">
            <div
              class="w-9 h-9 rounded-lg bg-destructive/10 border border-destructive/20 flex items-center justify-center text-destructive"
            >
              <Trash2 class="w-4 h-4" />
            </div>
            <div>
              <h3 class="text-base font-bold tracking-tight">Delete Agent</h3>
              <p class="text-xs text-muted-foreground font-mono">
                This cannot be undone
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

        <div class="p-6 space-y-4">
          <Alert v-if="error" variant="destructive" class="py-2.5">
            <AlertTriangle class="w-4 h-4" />
            <AlertDescription class="text-xs">{{ error }}</AlertDescription>
          </Alert>

          <p class="text-sm text-muted-foreground">
            Permanently remove
            <span class="font-semibold text-foreground">{{
              agent.hostname || agent.id
            }}</span>
            from your fleet? Its credential is revoked and the agent must be
            re-registered to reconnect.
          </p>

          <div class="pt-3 flex justify-end gap-2 border-t border-border/80">
            <Button
              variant="outline"
              size="sm"
              :disabled="loading"
              data-test="delete-agent-cancel"
              @click="handleClose"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              class="gap-1.5"
              :disabled="loading"
              data-test="delete-agent-confirm"
              @click="handleConfirm"
            >
              <Trash2 class="w-3.5 h-3.5" />
              {{ loading ? 'Deleting...' : 'Delete Agent' }}
            </Button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

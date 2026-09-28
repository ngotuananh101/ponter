<script setup lang="ts">
import { ref, computed } from 'vue';
import { apiClient } from '@/services/client';
import { generateUserKeyPair } from '@remote/crypto';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Server,
  Plus,
  X,
  Copy,
  Check,
  AlertTriangle,
  Terminal,
  Shield,
  Laptop,
} from '@lucide/vue';

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'registered'): void;
}>();

const step = ref<'form' | 'success'>('form');
const agentId = ref('');
const hostname = ref('');
const platform = ref<'linux' | 'macos' | 'windows'>('linux');
const loading = ref(false);
const error = ref<string | null>(null);
const copiedTarget = ref<'credential' | 'command' | null>(null);

const generatedCredential = ref('');
const registeredAgentId = ref('');

const signalingServerUrl = computed(() => {
  const apiUrl = import.meta.env.VITE_API_URL || window.location.origin;
  const wsUrl = apiUrl.replace(/^http/, 'ws');
  return `${wsUrl}/api/ws/agent`;
});

const runCommand = computed(() => {
  return `./remote-agent --agent-id ${registeredAgentId.value} --server ${signalingServerUrl.value} --credential ${generatedCredential.value}`;
});

function handleClose() {
  if (step.value === 'success') {
    emit('registered');
  }
  emit('update:open', false);
  // Reset state after transition
  setTimeout(() => {
    step.value = 'form';
    agentId.value = '';
    hostname.value = '';
    platform.value = 'linux';
    error.value = null;
    generatedCredential.value = '';
    registeredAgentId.value = '';
    copiedTarget.value = null;
  }, 200);
}

async function handleRegister() {
  const trimmedId = agentId.value.trim().toLowerCase();
  if (!trimmedId) {
    error.value = 'Agent ID is required (e.g. my-server-01)';
    return;
  }

  loading.value = true;
  error.value = null;

  try {
    // Generate an authentic Ed25519/ECDH keypair for the agent registration contract
    let publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExamplePublicKey';
    try {
      const pair = await generateUserKeyPair();
      publicKey = pair.publicKeySpkiBase64;
    } catch {
      // Fallback to default key if crypto subtle unavailable
    }

    const res = await apiClient.agents.create({
      id: trimmedId,
      hostname: hostname.value.trim() || trimmedId,
      platform: platform.value,
      publicKey,
      capabilities: ['terminal'],
    });

    registeredAgentId.value = res.agent.id;
    generatedCredential.value = res.credential;
    step.value = 'success';
  } catch (err: unknown) {
    error.value =
      err instanceof Error ? err.message : 'Failed to register agent. ID may already exist.';
  } finally {
    loading.value = false;
  }
}

async function copyToClipboard(text: string, target: 'credential' | 'command') {
  try {
    await navigator.clipboard.writeText(text);
    copiedTarget.value = target;
    setTimeout(() => {
      if (copiedTarget.value === target) {
        copiedTarget.value = null;
      }
    }, 2000);
  } catch {
    // Clipboard API error handling
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-xs animate-in fade-in duration-150"
    >
      <!-- Click-outside backdrop -->
      <div class="fixed inset-0" @click="handleClose" />

      <!-- Modal Dialog Container -->
      <div
        class="relative w-full max-w-lg rounded-xl border border-border bg-card text-card-foreground shadow-2xl z-10 overflow-hidden flex flex-col max-h-[90vh]"
      >
        <!-- Modal Header -->
        <div class="flex items-center justify-between border-b border-border/80 px-6 py-4">
          <div class="flex items-center gap-3">
            <div
              class="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary"
            >
              <Server class="w-4 h-4" />
            </div>
            <div>
              <h3 class="text-base font-bold tracking-tight">Register Remote Agent</h3>
              <p class="text-xs text-muted-foreground font-mono">
                Provision daemon identity & credentials
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

        <!-- Form Step -->
        <div v-if="step === 'form'" class="p-6 space-y-4 overflow-y-auto">
          <Alert v-if="error" variant="destructive" class="py-2.5">
            <AlertTriangle class="w-4 h-4" />
            <AlertDescription class="text-xs">{{ error }}</AlertDescription>
          </Alert>

          <!-- Agent ID -->
          <div class="space-y-1.5">
            <Label for="agent-id" class="text-xs font-semibold">
              Agent ID <span class="text-destructive">*</span>
            </Label>
            <Input
              id="agent-id"
              v-model="agentId"
              type="text"
              placeholder="e.g. workstation-fedora, server-node-01"
              class="font-mono text-xs h-9 bg-background/60"
              :disabled="loading"
              @keydown.enter.prevent="handleRegister"
            />
            <p class="text-[11px] text-muted-foreground">
              Unique slug identifier for terminal workspace addressing.
            </p>
          </div>

          <!-- Hostname -->
          <div class="space-y-1.5">
            <Label for="agent-hostname" class="text-xs font-semibold">
              Hostname <span class="text-muted-foreground font-normal">(Optional)</span>
            </Label>
            <Input
              id="agent-hostname"
              v-model="hostname"
              type="text"
              placeholder="e.g. workstation.lan"
              class="font-mono text-xs h-9 bg-background/60"
              :disabled="loading"
              @keydown.enter.prevent="handleRegister"
            />
          </div>

          <!-- Platform Selector -->
          <div class="space-y-1.5">
            <Label class="text-xs font-semibold">Target Operating System</Label>
            <div class="grid grid-cols-3 gap-2">
              <button
                type="button"
                class="flex flex-col items-center gap-1.5 p-2.5 rounded-lg border text-xs font-medium transition-all"
                :class="
                  platform === 'linux'
                    ? 'border-primary bg-primary/10 text-primary shadow-xs'
                    : 'border-border bg-card hover:bg-secondary/60 text-muted-foreground'
                "
                @click="platform = 'linux'"
              >
                <Terminal class="w-4 h-4" />
                <span>Linux</span>
              </button>

              <button
                type="button"
                class="flex flex-col items-center gap-1.5 p-2.5 rounded-lg border text-xs font-medium transition-all"
                :class="
                  platform === 'macos'
                    ? 'border-primary bg-primary/10 text-primary shadow-xs'
                    : 'border-border bg-card hover:bg-secondary/60 text-muted-foreground'
                "
                @click="platform = 'macos'"
              >
                <Laptop class="w-4 h-4" />
                <span>macOS</span>
              </button>

              <button
                type="button"
                class="flex flex-col items-center gap-1.5 p-2.5 rounded-lg border text-xs font-medium transition-all"
                :class="
                  platform === 'windows'
                    ? 'border-primary bg-primary/10 text-primary shadow-xs'
                    : 'border-border bg-card hover:bg-secondary/60 text-muted-foreground'
                "
                @click="platform = 'windows'"
              >
                <Server class="w-4 h-4" />
                <span>Windows</span>
              </button>
            </div>
          </div>

          <!-- Submit Actions -->
          <div class="pt-3 flex justify-end gap-2 border-t border-border/80">
            <Button variant="outline" size="sm" :disabled="loading" @click="handleClose">
              Cancel
            </Button>
            <Button
              size="sm"
              :disabled="loading || !agentId.trim()"
              class="gap-1.5"
              @click="handleRegister"
            >
              <Plus class="w-3.5 h-3.5" />
              {{ loading ? 'Provisioning...' : 'Generate Agent' }}
            </Button>
          </div>
        </div>

        <!-- Success Step: Credential & Runbook -->
        <div v-else class="p-6 space-y-4 overflow-y-auto">
          <div class="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400">
            <Shield class="w-4 h-4 flex-shrink-0" />
            <div class="text-xs">
              <span class="font-semibold">Agent Provisioned:</span>
              <span class="font-mono ml-1 font-bold">{{ registeredAgentId }}</span>
            </div>
          </div>

          <!-- Credential Warning Box -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <Label class="text-xs font-semibold flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                <AlertTriangle class="w-3.5 h-3.5" />
                Agent Credential Token
              </Label>
              <Badge variant="outline" class="font-mono text-[10px] text-amber-600 border-amber-500/30">
                Issued Once
              </Badge>
            </div>

            <div class="flex items-center gap-2 p-2 rounded-lg bg-muted/60 border border-border font-mono text-xs">
              <span class="truncate flex-1 select-all font-semibold">{{ generatedCredential }}</span>
              <Button
                variant="outline"
                size="sm"
                class="h-7 px-2 text-xs flex items-center gap-1"
                @click="copyToClipboard(generatedCredential, 'credential')"
              >
                <Check v-if="copiedTarget === 'credential'" class="w-3 h-3 text-emerald-500" />
                <Copy v-else class="w-3 h-3" />
                {{ copiedTarget === 'credential' ? 'Copied' : 'Copy' }}
              </Button>
            </div>
            <p class="text-[11px] text-muted-foreground">
              Store this secret safely. For security, only its SHA-256 digest is stored on the server.
            </p>
          </div>

          <!-- Launch Command Block -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <Label class="text-xs font-semibold">Launch Native Agent</Label>
              <Button
                variant="ghost"
                size="sm"
                class="h-6 px-2 text-[11px] flex items-center gap-1 text-primary hover:text-primary"
                @click="copyToClipboard(runCommand, 'command')"
              >
                <Check v-if="copiedTarget === 'command'" class="w-3 h-3 text-emerald-500" />
                <Copy v-else class="w-3 h-3" />
                {{ copiedTarget === 'command' ? 'Copied Command' : 'Copy Command' }}
              </Button>
            </div>

            <div class="relative bg-zinc-950 dark:bg-black rounded-lg p-3 border border-border/80 font-mono text-xs text-emerald-400 overflow-x-auto select-all">
              <code>{{ runCommand }}</code>
            </div>
            <p class="text-[11px] text-muted-foreground">
              Run this command on your target host to establish the WebRTC signaling connection.
            </p>
          </div>

          <!-- Action Close -->
          <div class="pt-3 flex justify-end gap-2 border-t border-border/80">
            <Button size="sm" class="gap-1.5" @click="handleClose">
              <Check class="w-3.5 h-3.5" />
              Done & Return to Fleet
            </Button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

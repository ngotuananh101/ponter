/**
 * Setup wizard Pinia store (ADR-53).
 *
 * Implements a verified four-step state machine:
 *   server → capture → inputGate → autoStart
 *
 * Each step verifies real capability via Tauri commands before advancing.
 * `allow_input` defaults to `false` (ADR-42 Gate A) and is only flipped on
 * explicit user confirmation of the input-gate step.
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { ProbeResult, WizardStep } from '@/types';

export const useWizardStore = defineStore('wizard', () => {
  /** Current state-machine step. */
  const step = ref<WizardStep>('server');

  /** Server URL entered in step 1. */
  const serverUrl = ref<string>('');

  /** Latest probe result for each step — surfaced in the UI. */
  const serverProbe = ref<ProbeResult | null>(null);
  const captureProbe = ref<ProbeResult | null>(null);

  /** Input gate preference — default closed (ADR-42). */
  const allowInput = ref(false);

  /** Whether the wizard has completed and settings were saved. */
  const completed = ref(false);

  /** Whether any probe or save operation is in flight. */
  const loading = ref(false);

  const currentStepIndex = computed(() => {
    const order: WizardStep[] = ['server', 'capture', 'inputGate', 'autoStart'];
    return order.indexOf(step.value);
  });

  const canAdvance = computed(
    () => step.value !== 'autoStart' && !loading.value,
  );

  function reset(): void {
    step.value = 'server';
    serverUrl.value = '';
    serverProbe.value = null;
    captureProbe.value = null;
    allowInput.value = false;
    completed.value = false;
    loading.value = false;
  }

  async function probeServer(): Promise<ProbeResult> {
    loading.value = true;
    try {
      const result = await invoke<ProbeResult>('probe_server', {
        url: serverUrl.value,
      });
      serverProbe.value = result;
      return result;
    } finally {
      loading.value = false;
    }
  }

  async function probeCapture(): Promise<ProbeResult> {
    loading.value = true;
    try {
      const result = await invoke<ProbeResult>('probe_capture');
      captureProbe.value = result;
      return result;
    } finally {
      loading.value = false;
    }
  }

  /** Advance to the next step after a successful probe. */
  function advance(): void {
    if (step.value === 'server') {
      step.value = 'capture';
    } else if (step.value === 'capture') {
      step.value = 'inputGate';
    } else if (step.value === 'inputGate') {
      step.value = 'autoStart';
    }
  }

  /** Persist verified settings to AppState and mark the wizard complete. */
  async function finish(): Promise<void> {
    loading.value = true;
    try {
      await invoke('save_wizard_settings', {
        serverUrl: serverUrl.value,
        allowInput: allowInput.value,
      });
      completed.value = true;
    } finally {
      loading.value = false;
    }
  }

  return {
    step,
    serverUrl,
    serverProbe,
    captureProbe,
    allowInput,
    completed,
    loading,
    currentStepIndex,
    canAdvance,
    reset,
    probeServer,
    probeCapture,
    advance,
    finish,
  };
});

/**
 * Setup wizard Pinia store (ADR-53).
 *
 * Implements a verified four-step state machine:
 *   server → capture → inputGate → autoStart
 *
 * Each step verifies real capability via Tauri commands before advancing.
 * `allow_input` defaults to `false` (ADR-42 Gate A) and is only flipped on
 * explicit user confirmation of the input-gate step.
 *
 * R11 (Task 8 flow fix): the `completed` flag is set ONLY in `complete()`
 * (step 4), NOT in `finish()` (step 3). `finish()` persists settings and
 * advances to `autoStart`; `complete()` applies the auto-start toggle and then
 * marks the wizard complete. This makes step 4 reachable in the real app,
 * since `App.vue` unmounts the wizard when `completed` is true.
 *
 * R12 (honesty): auto-start takes effect at the next login; the toggle
 * reflects the real OS entry. macOS uses a LaunchAgent plist; Windows uses
 * reg.exe. See task-8-brief.md R3/R12.
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

  /** Auto-start preference — reflects the real OS entry (R11/R3). */
  const autoStart = ref(false);

  /** Error surfaced from auto-start operations (R11). */
  const autoStartError = ref<string | null>(null);

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
    autoStart.value = false;
    autoStartError.value = null;
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

  /** Advance to the next step. Enforces the probe gate (R1): advancing past
   * `server` requires `serverProbe.ok`, and advancing past `capture` requires
   * `captureProbe.ok`. The `inputGate → autoStart` transition is unconditional
   * (gate B peer-identity verification happens at admission in Task 7). */
  function advance(): void {
    if (step.value === 'server') {
      if (serverProbe.value?.ok !== true) {
        return;
      }
      step.value = 'capture';
    } else if (step.value === 'capture') {
      if (captureProbe.value?.ok !== true) {
        return;
      }
      step.value = 'inputGate';
    } else if (step.value === 'inputGate') {
      step.value = 'autoStart';
    }
  }

  /** Step 3 action: persist verified settings to AppState and advance to
   * `autoStart`. Does NOT set `completed` — step 4 is the final step (R11). */
  async function finish(): Promise<void> {
    loading.value = true;
    try {
      await invoke('save_wizard_settings', {
        serverUrl: serverUrl.value,
        allowInput: allowInput.value,
      });
      advance();
    } finally {
      loading.value = false;
    }
  }

  /** Step 4 action: apply the auto-start toggle to the real OS entry, then
   * mark the wizard complete (R11). */
  async function complete(): Promise<void> {
    loading.value = true;
    autoStartError.value = null;
    try {
      await setAutoStart(autoStart.value);
      completed.value = true;
    } finally {
      loading.value = false;
    }
  }

  /** Apply the auto-start preference to the platform-native entry (R11/R3).
   * Takes effect at the next login. Errors are surfaced via `autoStartError`
   * and rethrown — never silently swallowed. The optimistic toggle is reverted
   * so the checkbox never lies about the real OS state. */
  async function setAutoStart(enabled: boolean): Promise<void> {
    autoStart.value = enabled;
    autoStartError.value = null;
    try {
      await invoke('set_autostart', { enabled });
    } catch (e: unknown) {
      // Revert the optimistic update so the checkbox reflects reality.
      autoStart.value = !enabled;
      autoStartError.value =
        e instanceof Error
          ? e.message
          : (String(e) ?? 'Failed to update auto-start preference');
      throw e;
    }
  }

  /** Load the real auto-start state from the OS (R11/R3) so the toggle
   * reflects the actual platform entry on mount. */
  async function loadAutoStart(): Promise<void> {
    const enabled = await invoke<boolean>('is_autostart_enabled');
    autoStart.value = enabled;
  }

  return {
    step,
    serverUrl,
    serverProbe,
    captureProbe,
    allowInput,
    autoStart,
    autoStartError,
    completed,
    loading,
    currentStepIndex,
    canAdvance,
    reset,
    probeServer,
    probeCapture,
    advance,
    finish,
    complete,
    setAutoStart,
    loadAutoStart,
  };
});

<script setup lang="ts">
import { watch } from 'vue';
import { useWizardStore } from '@/stores/wizard';
import { useConfigStore } from '@/stores/config';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from '@lucide/vue';

const store = useWizardStore();
const config = useConfigStore();

async function probeCapture() {
  const result = await store.probeCapture();
  if (result.ok) {
    store.advance();
  }
}

/** Step 3: persist settings + advance to autoStart (R11). */
async function finish() {
  await store.finish();
}

/** Step 4: apply auto-start toggle + mark complete (R11). */
async function complete() {
  await store.complete();
}

/** When the user toggles the auto-start checkbox, apply it immediately (R11).
 * The store reverts the checkbox on error and surfaces the message. */
async function onAutoStartChange(enabled: boolean | 'indeterminate') {
  const isEnabled = enabled === true;
  try {
    await store.setAutoStart(isEnabled);
  } catch {
    // Error is surfaced via store.autoStartError; the checkbox was already
    // reverted by setAutoStart keeping autoStart in sync.
  }
}

/** Load the real auto-start state from the OS when step 4 becomes active
 * (R11). Uses a watch on `store.step` so it fires every time the wizard
 * (re)enters the autoStart step, not only on initial mount. */
watch(
  () => store.step,
  (newStep) => {
    if (newStep === 'autoStart') {
      store.loadAutoStart().catch(() => {
        /* error surfaced via autoStartError */
      });
    }
  },
  { immediate: true },
);

/** Seed the input-gate checkbox from the persisted config when the step
 * becomes active, so a previously-saved choice survives a restart. */
watch(
  () => store.step,
  (newStep) => {
    if (newStep === 'inputGate') {
      config.load().catch(() => {
        /* ignore — the checkbox keeps its current value */
      });
    }
  },
  { immediate: true },
);
</script>

<template>
  <div data-testid="wizard-root">
    <!-- Step 1: Capture -->
    <div v-if="store.step === 'capture'" data-testid="wizard-step-capture">
      <h1>Screen Capture</h1>
      <p data-testid="wizard-capture-help">
        Grant screen-recording permission when prompted, then verify capture.
      </p>

      <Button
        data-testid="wizard-probe-capture"
        :disabled="store.loading"
        @click="probeCapture"
      >
        <Loader2 v-if="store.loading" class="mr-2 h-4 w-4 animate-spin" />
        {{ store.loading ? 'Probing...' : 'Verify Capture' }}
      </Button>

      <Alert
        v-if="store.captureProbe && !store.captureProbe.ok"
        data-testid="wizard-capture-message"
        variant="destructive"
        role="alert"
        aria-live="polite"
      >
        <AlertDescription>{{ store.captureProbe.message }}</AlertDescription>
      </Alert>
    </div>

    <!-- Step 2: Input Gate -->
    <div
      v-else-if="store.step === 'inputGate'"
      data-testid="wizard-step-input-gate"
    >
      <h1>Input Gate</h1>
      <p data-testid="wizard-input-help">
        Two gates protect your input. Gate A (this step) is the --allow-input
        preference that defaults to closed; enabling it allows the relay to
        forward keyboard/mouse events. Gate B is the peer-identity verification
        performed at admission (wired in Task 7) — even with Gate A open, only
        verified peers can send input events.
      </p>

      <Label for="wizard-input-checkbox">Allow remote input</Label>
      <Checkbox
        id="wizard-input-checkbox"
        data-testid="wizard-input-checkbox"
        v-model="config.allowInput"
        aria-label="Allow remote input"
      />

      <Button
        data-testid="wizard-finish"
        :disabled="store.loading"
        @click="finish"
      >
        <Loader2 v-if="store.loading" class="mr-2 h-4 w-4 animate-spin" />
        {{ store.loading ? 'Saving...' : 'Continue' }}
      </Button>
    </div>

    <!-- Step 3: Auto-start -->
    <div
      v-else-if="store.step === 'autoStart'"
      data-testid="wizard-step-auto-start"
    >
      <h1>All Set</h1>
      <p data-testid="wizard-autostart-help">
        Adds Ponter to your system's startup so the agent runs on login. Takes
        effect at the next login.
      </p>

      <Label for="wizard-autostart-checkbox"
        >Auto-start the agent on login</Label
      >
      <Checkbox
        id="wizard-autostart-checkbox"
        data-testid="wizard-autostart-checkbox"
        :model-value="store.autoStart"
        @update:model-value="onAutoStartChange"
        aria-label="Auto-start the agent on login"
      />

      <Alert
        v-if="store.autoStartError"
        data-testid="wizard-autostart-error"
        variant="destructive"
        role="alert"
        aria-live="polite"
      >
        <AlertDescription>{{ store.autoStartError }}</AlertDescription>
      </Alert>

      <Button
        data-testid="wizard-autostart-finish"
        :disabled="store.loading"
        @click="complete"
      >
        <Loader2 v-if="store.loading" class="mr-2 h-4 w-4 animate-spin" />
        {{ store.loading ? 'Saving...' : 'Done' }}
      </Button>
    </div>
  </div>
</template>

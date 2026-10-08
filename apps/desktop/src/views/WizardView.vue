<script setup lang="ts">
import { watch } from 'vue';
import { useWizardStore } from '@/stores/wizard';

const store = useWizardStore();

async function probeServer() {
  const result = await store.probeServer();
  if (result.ok) {
    store.advance();
  }
}

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
async function onAutoStartChange(enabled: boolean) {
  try {
    await store.setAutoStart(enabled);
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
</script>

<template>
  <div data-testid="wizard-root">
    <!-- Step 1: Server -->
    <div v-if="store.step === 'server'" data-testid="wizard-step-server">
      <h2>Server Connection</h2>
      <p data-testid="wizard-server-help">
        Enter your Ponter server URL to verify connectivity.
      </p>

      <label for="wizard-server-url-input">
        <span class="sr-only">Server URL</span>
      </label>
      <input
        id="wizard-server-url-input"
        type="url"
        data-testid="wizard-server-url"
        aria-label="Server URL"
        placeholder="http://localhost:8787"
        v-model="store.serverUrl"
      />

      <button
        data-testid="wizard-probe-server"
        :disabled="store.loading || !store.serverUrl"
        @click="probeServer"
      >
        {{ store.loading ? 'Probing...' : 'Probe Server' }}
      </button>

      <p v-if="store.serverProbe" data-testid="wizard-server-message">
        {{ store.serverProbe.message }}
      </p>
    </div>

    <!-- Step 2: Capture -->
    <div v-else-if="store.step === 'capture'" data-testid="wizard-step-capture">
      <h2>Screen Capture</h2>
      <p data-testid="wizard-capture-help">
        Grant screen-recording permission when prompted, then verify capture.
      </p>

      <button
        data-testid="wizard-probe-capture"
        :disabled="store.loading"
        @click="probeCapture"
      >
        {{ store.loading ? 'Probing...' : 'Probe Capture' }}
      </button>

      <p v-if="store.captureProbe" data-testid="wizard-capture-message">
        {{ store.captureProbe.message }}
      </p>
    </div>

    <!-- Step 3: Input Gate -->
    <div
      v-else-if="store.step === 'inputGate'"
      data-testid="wizard-step-input-gate"
    >
      <h2>Input Gate</h2>
      <p data-testid="wizard-input-help">
        Two gates protect your input. Gate A (this step) is the --allow-input
        preference that defaults to closed; enabling it allows the relay to
        forward keyboard/mouse events. Gate B is the peer-identity verification
        performed at admission (wired in Task 7) — even with Gate A open, only
        verified peers can send input events.
      </p>

      <label>
        <input
          type="checkbox"
          data-testid="wizard-input-checkbox"
          v-model="store.allowInput"
        />
        Allow remote input
      </label>

      <button
        data-testid="wizard-finish"
        :disabled="store.loading"
        @click="finish"
      >
        {{ store.loading ? 'Saving...' : 'Continue' }}
      </button>
    </div>

    <!-- Step 4: Auto-start -->
    <div
      v-else-if="store.step === 'autoStart'"
      data-testid="wizard-step-auto-start"
    >
      <h2>All Set</h2>
      <p data-testid="wizard-autostart-help">
        Adds Ponter to your system's startup so the agent runs on login. Takes
        effect at the next login.
      </p>

      <label>
        <input
          type="checkbox"
          data-testid="wizard-autostart-checkbox"
          :checked="store.autoStart"
          @change="onAutoStartChange($event.target.checked)"
        />
        Auto-start the agent on login
      </label>

      <p v-if="store.autoStartError" data-testid="wizard-autostart-error">
        {{ store.autoStartError }}
      </p>

      <button
        data-testid="wizard-autostart-finish"
        :disabled="store.loading"
        @click="complete"
      >
        {{ store.loading ? 'Saving...' : 'Finish' }}
      </button>
    </div>
  </div>
</template>

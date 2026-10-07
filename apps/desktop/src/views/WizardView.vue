<script setup lang="ts">
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

async function finish() {
  await store.finish();
  if (store.completed) {
    store.advance();
  }
}
</script>

<template>
  <div data-testid="wizard-root">
    <!-- Step 1: Server -->
    <div v-if="store.step === 'server'" data-testid="wizard-step-server">
      <h2>Server Connection</h2>
      <p data-testid="wizard-server-help">
        Enter your Ponter server URL to verify connectivity.
      </p>

      <input
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
        {{ store.loading ? 'Saving...' : 'Finish' }}
      </button>
    </div>

    <!-- Step 4: Auto-start -->
    <div
      v-else-if="store.step === 'autoStart'"
      data-testid="wizard-step-auto-start"
    >
      <h2>All Set</h2>
      <p data-testid="wizard-complete">
        Wizard complete. Verified settings are saved to the agent's runtime
        state. Installs the launch entry — wiring arrives in Task 8 (ADR-55).
      </p>
      <label>
        <input
          type="checkbox"
          data-testid="wizard-autostart-checkbox"
          v-model="store.autoStart"
        />
        Auto-start the agent on login
      </label>
    </div>
  </div>
</template>

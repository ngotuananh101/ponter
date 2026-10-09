<script setup lang="ts">
import { watch } from 'vue';
import { useWizardStore } from '@/stores/wizard';
import { useConfigStore } from '@/stores/config';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import ThemeToggle from '@/components/ThemeToggle.vue';
import { Monitor, ShieldCheck, Zap, Loader2 } from '@lucide/vue';

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
  <div data-testid="wizard-root" class="w-full max-w-lg">
    <Card class="border-border/80 bg-card/95 shadow-xl backdrop-blur-sm">
      <CardHeader class="space-y-4 pb-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span
              class="text-xs font-mono font-medium px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20"
            >
              AGENT SETUP
            </span>
          </div>
          <ThemeToggle />
        </div>

        <!-- Stepper Navigation -->
        <div
          class="grid grid-cols-3 gap-2 border-b border-border/60 pb-3 text-xs font-medium"
        >
          <div
            class="flex items-center gap-1.5 pb-1"
            :class="
              store.step === 'capture'
                ? 'text-primary font-semibold border-b-2 border-primary'
                : 'text-muted-foreground'
            "
          >
            <Monitor class="w-3.5 h-3.5" />
            <span>1. Capture</span>
          </div>
          <div
            class="flex items-center gap-1.5 pb-1"
            :class="
              store.step === 'inputGate'
                ? 'text-primary font-semibold border-b-2 border-primary'
                : 'text-muted-foreground'
            "
          >
            <ShieldCheck class="w-3.5 h-3.5" />
            <span>2. Input</span>
          </div>
          <div
            class="flex items-center gap-1.5 pb-1"
            :class="
              store.step === 'autoStart'
                ? 'text-primary font-semibold border-b-2 border-primary'
                : 'text-muted-foreground'
            "
          >
            <Zap class="w-3.5 h-3.5" />
            <span>3. System</span>
          </div>
        </div>
      </CardHeader>

      <CardContent class="space-y-5">
        <!-- Step 1: Capture -->
        <div
          v-if="store.step === 'capture'"
          data-testid="wizard-step-capture"
          class="space-y-4"
        >
          <div>
            <h1 class="text-xl font-bold tracking-tight">Screen Capture</h1>
            <p
              data-testid="wizard-capture-help"
              class="text-sm text-muted-foreground mt-1"
            >
              Grant screen-recording permission when prompted, then verify
              capture.
            </p>
          </div>

          <Alert
            v-if="store.captureProbe && !store.captureProbe.ok"
            data-testid="wizard-capture-message"
            variant="destructive"
            role="alert"
            aria-live="polite"
          >
            <AlertDescription>{{
              store.captureProbe.message
            }}</AlertDescription>
          </Alert>

          <Button
            data-testid="wizard-probe-capture"
            :disabled="store.loading"
            class="w-full font-medium"
            @click="probeCapture"
          >
            <Loader2 v-if="store.loading" class="mr-2 h-4 w-4 animate-spin" />
            {{ store.loading ? 'Probing...' : 'Verify Capture' }}
          </Button>
        </div>

        <!-- Step 2: Input Gate -->
        <div
          v-else-if="store.step === 'inputGate'"
          data-testid="wizard-step-input-gate"
          class="space-y-4"
        >
          <div>
            <h1 class="text-xl font-bold tracking-tight">Input Gate</h1>
            <p
              data-testid="wizard-input-help"
              class="text-sm text-muted-foreground mt-1 leading-relaxed"
            >
              Two gates protect your input. Gate A (this step) is the
              --allow-input preference that defaults to closed; enabling it
              allows the relay to forward keyboard/mouse events. Gate B is the
              peer-identity verification performed at admission — even with Gate
              A open, only verified peers can send input events.
            </p>
          </div>

          <label
            for="wizard-input-checkbox"
            class="p-3.5 rounded-lg border border-border/80 bg-muted/30 flex items-center justify-between gap-4 cursor-pointer hover:bg-muted/50 transition-colors"
          >
            <div class="space-y-0.5">
              <span class="text-sm font-medium text-foreground block"
                >Allow remote input</span
              >
              <span class="text-xs text-muted-foreground block"
                >Enable remote control of mouse and keyboard</span
              >
            </div>
            <Checkbox
              id="wizard-input-checkbox"
              data-testid="wizard-input-checkbox"
              v-model="config.allowInput"
              aria-label="Allow remote input"
            />
          </label>

          <Button
            data-testid="wizard-finish"
            :disabled="store.loading"
            class="w-full font-medium"
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
          class="space-y-4"
        >
          <div>
            <h1 class="text-xl font-bold tracking-tight">All Set</h1>
            <p
              data-testid="wizard-autostart-help"
              class="text-sm text-muted-foreground mt-1"
            >
              Adds Ponter to your system's startup so the agent runs on login.
              Takes effect at the next login.
            </p>
          </div>

          <label
            for="wizard-autostart-checkbox"
            class="p-3.5 rounded-lg border border-border/80 bg-muted/30 flex items-center justify-between gap-4 cursor-pointer hover:bg-muted/50 transition-colors"
          >
            <div class="space-y-0.5">
              <span class="text-sm font-medium text-foreground block"
                >Auto-start the agent on login</span
              >
              <span class="text-xs text-muted-foreground block"
                >Launch agent in background at system startup</span
              >
            </div>
            <Checkbox
              id="wizard-autostart-checkbox"
              data-testid="wizard-autostart-checkbox"
              :model-value="store.autoStart"
              @update:model-value="onAutoStartChange"
              aria-label="Auto-start the agent on login"
            />
          </label>

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
            class="w-full font-medium"
            @click="complete"
          >
            <Loader2 v-if="store.loading" class="mr-2 h-4 w-4 animate-spin" />
            {{ store.loading ? 'Saving...' : 'Done' }}
          </Button>
        </div>
      </CardContent>
    </Card>
  </div>
</template>

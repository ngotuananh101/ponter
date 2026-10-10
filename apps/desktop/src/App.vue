<script setup lang="ts">
import { onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useWizardStore } from '@/stores/wizard';
import { useConfigStore } from '@/stores/config';
import ServerSetupView from '@/views/ServerSetupView.vue';
import LoginView from '@/views/LoginView.vue';
import WizardView from '@/views/WizardView.vue';
import DevicesView from '@/views/DevicesView.vue';

const authStore = useAuthStore();
const wizardStore = useWizardStore();
const configStore = useConfigStore();

onMounted(() => {
  // Load persisted config once. `load()` sets `configLoaded` to true on BOTH
  // success and failure (try/finally); this `.catch` additionally swallows the
  // rejection so a failed `get_config` does not surface as an unhandled promise
  // rejection in the webview. The gate flag always flips regardless.
  void configStore.load().catch(() => {});
});
</script>

<template>
  <!-- Startup-flash gate (ADR-66/D): until `configLoaded`, render only the
  neutral shell background — no view decision until the first route is possible. -->
  <div
    data-testid="app-shell"
    class="min-h-screen flex items-center justify-center p-4 sm:p-6 bg-gradient-to-b from-background via-background to-muted/20 select-none text-foreground"
  >
    <template v-if="configStore.configLoaded">
      <ServerSetupView
        v-if="!configStore.hasServerUrl || configStore.editing"
      />
      <LoginView v-else-if="!authStore.isAuthenticated" />
      <WizardView v-else-if="!wizardStore.completed" />
      <DevicesView v-else />
    </template>
  </div>
</template>

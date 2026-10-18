<script setup lang="ts">
import { onMounted } from 'vue';
import { useConfigStore } from '@/stores/config';
import { useAuthStore } from '@/stores/auth';
import { useWizardStore } from '@/stores/wizard';
import { initDesktopTheme } from '@/composables/useTheme';
import ServerSetupView from '@/views/ServerSetupView.vue';
import LoginView from '@/views/LoginView.vue';
import WizardView from '@/views/WizardView.vue';
import DevicesView from '@/views/DevicesView.vue';

const config = useConfigStore();
const auth = useAuthStore();
const wizard = useWizardStore();

onMounted(async () => {
  await config.load();
  initDesktopTheme(config.theme);
  if (config.hasServerUrl) {
    await auth.restoreSession();
  }
});
</script>

<template>
  <!-- Startup-flash gate (ADR-66/D): until `configLoaded`, render only the
  neutral shell background — no view decision until the first route is possible. -->
  <div
    data-testid="app-shell"
    class="min-h-screen flex items-center justify-center p-4 sm:p-6 bg-gradient-to-b from-background via-background to-muted/20 select-none text-foreground"
  >
    <template v-if="config.configLoaded">
      <ServerSetupView v-if="!config.hasServerUrl || config.editing" />
      <LoginView v-else-if="!auth.isAuthenticated" />
      <WizardView v-else-if="wizard.inProgress" />
      <DevicesView v-else />
    </template>
  </div>
</template>

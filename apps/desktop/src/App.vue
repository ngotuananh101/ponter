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
  // Load persisted config once; ignore failure (the app still renders).
  configStore.load().catch(() => {});
});
</script>

<template>
  <ServerSetupView v-if="!configStore.hasServerUrl || configStore.editing" />
  <LoginView v-else-if="!authStore.isAuthenticated" />
  <WizardView v-else-if="!wizardStore.completed" />
  <DevicesView v-else />
</template>

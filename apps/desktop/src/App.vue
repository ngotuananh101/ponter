<script setup lang="ts">
import { useAuthStore } from '@/stores/auth';
import { useWizardStore } from '@/stores/wizard';
import LoginView from '@/views/LoginView.vue';
import WizardView from '@/views/WizardView.vue';
import DevicesView from '@/views/DevicesView.vue';

const authStore = useAuthStore();
const wizardStore = useWizardStore();
</script>

<template>
  <LoginView v-if="!authStore.isAuthenticated" />
  <WizardView v-else-if="!wizardStore.completed" />
  <DevicesView v-else />
</template>

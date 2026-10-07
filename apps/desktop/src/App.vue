<script setup lang="ts">
import { useAuthStore } from '@/stores/auth';
import LoginView from '@/views/LoginView.vue';

const store = useAuthStore();
</script>

<template>
  <LoginView v-if="!store.isAuthenticated" />
  <p v-else data-testid="welcome">Signed in as {{ store.user?.username }}</p>
  <p v-if="store.isAuthenticated">The setup wizard arrives in Task 5.</p>
</template>

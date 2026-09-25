<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import LoginForm from '@/components/auth/LoginForm.vue';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

async function handleLogin(payload: { username: string; password: string }) {
  try {
    await authStore.login(payload.username, payload.password);
    const redirect = (route.query.redirect as string) || '/dashboard';
    router.push(redirect);
  } catch {
    // Error state is captured in store
  }
}
</script>

<template>
  <div
    class="container mx-auto flex items-center justify-center min-h-[calc(100vh-4rem)] p-4"
  >
    <LoginForm
      :loading="authStore.status === 'loading'"
      :error-message="authStore.error"
      @submit="handleLogin"
    />
  </div>
</template>

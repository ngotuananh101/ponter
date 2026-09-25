<script setup lang="ts">
import { onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { safeRedirect } from '@/lib/safe-redirect';
import LoginForm from '@/components/auth/LoginForm.vue';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

onMounted(() => {
  authStore.clearError();
});

async function handleLogin(payload: { username: string; password: string }) {
  try {
    await authStore.login(payload.username, payload.password);
    router.push(safeRedirect(route.query.redirect));
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

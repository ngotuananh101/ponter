<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import RegisterForm from '@/components/auth/RegisterForm.vue';

const router = useRouter();
const authStore = useAuthStore();

async function handleRegister(payload: {
  username: string;
  email?: string;
  password: string;
}) {
  try {
    await authStore.register(payload);
    router.push('/dashboard');
  } catch {
    // Error state is captured in store
  }
}
</script>

<template>
  <div
    class="container mx-auto flex items-center justify-center min-h-[calc(100vh-4rem)] p-4"
  >
    <RegisterForm
      :loading="authStore.status === 'loading'"
      :error-message="authStore.error"
      @submit="handleRegister"
    />
  </div>
</template>

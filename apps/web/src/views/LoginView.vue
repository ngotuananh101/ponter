<script setup lang="ts">
import { onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { safeRedirect } from '@/lib/safe-redirect';
import { isApiError } from '@ponter/api-client';
import LoginForm from '@/components/auth/LoginForm.vue';
import { toast } from 'vue-sonner';

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
  } catch (err) {
    // The store rethrows the ApiError. Detect the pending-approval case here
    // (not in the store) and surface a dedicated informative toast.
    if (isApiError(err) && err.code === 'USER_PENDING_APPROVAL') {
      toast.warning(
        'Your account is pending admin approval. Please wait for an administrator to approve your registration before you can sign in.',
      );
    }
    // Otherwise the generic error is captured in store.error
  }
}
</script>

<template>
  <div
    class="container mx-auto flex items-center justify-center min-h-[calc(100vh-var(--header-height))] p-4"
  >
    <LoginForm
      :loading="authStore.status === 'loading'"
      :error-message="authStore.error"
      @submit="handleLogin"
    />
  </div>
</template>

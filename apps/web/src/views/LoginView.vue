<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { safeRedirect } from '@/lib/safe-redirect';
import { isApiError } from '@ponter/api-client';
import LoginForm from '@/components/auth/LoginForm.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Clock } from '@lucide/vue';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const pendingApproval = ref(false);

onMounted(() => {
  authStore.clearError();
});

async function handleLogin(payload: { username: string; password: string }) {
  pendingApproval.value = false;
  try {
    await authStore.login(payload.username, payload.password);
    router.push(safeRedirect(route.query.redirect));
  } catch (err) {
    // The store rethrows the ApiError. Detect the pending-approval case here
    // (not in the store) and surface a dedicated informative alert.
    if (isApiError(err) && err.code === 'USER_PENDING_APPROVAL') {
      pendingApproval.value = true;
    }
    // Otherwise the generic error is captured in store.error
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
    <Alert
      v-if="pendingApproval"
      data-test="login-pending-alert"
      variant="default"
      class="mt-4 max-w-md border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/30"
    >
      <div class="flex items-start gap-2">
        <Clock class="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400" />
        <AlertDescription class="text-xs text-amber-800 dark:text-amber-200">
          Your account is pending admin approval. Please wait for an
          administrator to approve your registration before you can sign in.
        </AlertDescription>
      </div>
    </Alert>
  </div>
</template>

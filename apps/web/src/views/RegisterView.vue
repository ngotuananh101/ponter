<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import RegisterForm from '@/components/auth/RegisterForm.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';

const router = useRouter();
const authStore = useAuthStore();

onMounted(() => {
  authStore.clearError();
});

async function handleRegister(payload: {
  username: string;
  email?: string;
  password: string;
}) {
  try {
    await authStore.register(payload);
    // When registration requires admin approval, the store sets user to null.
    if (authStore.user === null) {
      return; // Show the pending-approval confirmation below
    }
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
    <!-- Pending-approval confirmation (user is null when account awaits approval) -->
    <Alert
      v-if="authStore.user === null && authStore.error"
      variant="default"
      class="mt-4 max-w-md border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-950/30"
    >
      <AlertDescription class="text-xs text-emerald-800 dark:text-emerald-200">
        Đăng ký thành công! Tài khoản của bạn đang chờ Quản trị viên phê duyệt
        trước khi có thể đăng nhập.
      </AlertDescription>
    </Alert>
  </div>
</template>

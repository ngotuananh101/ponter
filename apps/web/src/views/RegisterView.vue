<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import RegisterForm from '@/components/auth/RegisterForm.vue';
import { toast } from 'vue-sonner';

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
      toast.success(
        'Đăng ký thành công! Tài khoản của bạn đang chờ Quản trị viên phê duyệt trước khi có thể đăng nhập.',
      );
      return;
    }
    router.push('/dashboard');
  } catch {
    // Error state is captured in store
  }
}
</script>

<template>
  <div
    class="container mx-auto flex items-center justify-center min-h-[calc(100vh-var(--header-height))] p-4"
  >
    <RegisterForm
      :loading="authStore.status === 'loading'"
      :error-message="authStore.error"
      @submit="handleRegister"
    />
  </div>
</template>

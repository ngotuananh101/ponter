import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import RegisterView from '@/views/RegisterView.vue';
import { useAuthStore } from '@/stores/auth';
import { ApiError } from '@ponter/api-client';

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { toast } from 'vue-sonner';

describe('RegisterView.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('calls toast.success with the approval-pending sentence on a registration that requires approval (user null)', async () => {
    const store = useAuthStore();
    // Mock register to simulate the requires-approval path in RegisterView:
    // the store sets user=null when the server response has requiresApproval.
    vi.spyOn(store, 'register').mockImplementation(async () => {
      store.user = null;
      store.requiresApproval = true;
      store.status = 'idle';
    });

    const wrapper = mount(RegisterView, {
      global: { stubs: { RouterLink: true } },
    });

    await wrapper.findComponent({ name: 'RegisterForm' }).vm.$emit('submit', {
      username: 'newuser',
      email: 'new@example.com',
      password: 'password123',
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(toast.success).toHaveBeenCalledWith(
      'Đăng ký thành công! Tài khoản của bạn đang chờ Quản trị viên phê duyệt trước khi có thể đăng nhập.',
    );
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('does NOT call toast.success when registration fails', async () => {
    const store = useAuthStore();
    vi.spyOn(store, 'register').mockRejectedValue(
      new ApiError('Username already taken', 409, 'CONFLICT'),
    );

    const wrapper = mount(RegisterView, {
      global: { stubs: { RouterLink: true } },
    });

    await wrapper.findComponent({ name: 'RegisterForm' }).vm.$emit('submit', {
      username: 'newuser',
      email: 'new@example.com',
      password: 'password123',
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(toast.success).not.toHaveBeenCalled();
  });
});

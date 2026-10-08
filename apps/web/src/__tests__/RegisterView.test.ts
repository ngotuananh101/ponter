import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import RegisterView from '@/views/RegisterView.vue';
import { useAuthStore } from '@/stores/auth';
import { ApiError } from '@ponter/api-client';
import type { User } from '@ponter/shared';

const push = vi.fn();

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ query: {} }),
}));

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
    push.mockReset();
  });

  it('calls toast.success with the approval-pending sentence on a registration that requires approval (user null), and does NOT redirect', async () => {
    const store = useAuthStore();
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
      'Registration successful! Your account is pending admin approval. You will be able to sign in once an administrator approves your registration.',
    );
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('redirects to /dashboard (no toast) on a successful non-pending registration', async () => {
    const store = useAuthStore();
    const mockUser: User = {
      id: 'u1',
      username: 'newuser',
      email: null,
      publicKey: 'pk',
      role: 'user',
      approvalStatus: 'approved',
      isActive: true,
      createdAt: '2026-10-04T00:00:00Z',
      updatedAt: '2026-10-04T00:00:00Z',
      lastLoginAt: null,
    };
    vi.spyOn(store, 'register').mockImplementation(async () => {
      store.user = mockUser;
      store.requiresApproval = false;
      store.status = 'authenticated';
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

    expect(push).toHaveBeenCalledWith('/dashboard');
    expect(toast.success).not.toHaveBeenCalled();
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

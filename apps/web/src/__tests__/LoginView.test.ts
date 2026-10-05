import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import LoginView from '@/views/LoginView.vue';
import { apiClient } from '@/services/client';
import { ApiError } from '@ponter/api-client';

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { toast } from 'vue-sonner';

/**
 * Mount LoginView and drive a login submit through its LoginForm, settling the
 * async handler so the resulting toast (if any) has fired.
 */
async function submitLogin(credentials: {
  username: string;
  password: string;
}) {
  const wrapper = mount(LoginView, {
    global: { stubs: { RouterLink: true, RouterView: true } },
  });
  await wrapper.vm.$nextTick();

  const loginForm = wrapper.findComponent({ name: 'LoginForm' });
  await loginForm.vm.$emit('submit', credentials);
  await wrapper.vm.$nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();

  return wrapper;
}

describe('LoginView.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('calls toast.warning when login rejects with USER_PENDING_APPROVAL', async () => {
    vi.spyOn(apiClient.auth, 'login').mockRejectedValue(
      new ApiError('Awaiting approval', 403, 'USER_PENDING_APPROVAL'),
    );

    await submitLogin({
      username: 'pending',
      password: 'password',
    });

    expect(toast.warning).toHaveBeenCalledWith(
      'Your account is pending admin approval. Please wait for an administrator to approve your registration before you can sign in.',
    );
  });

  it('does NOT call toast.warning on a generic login error', async () => {
    vi.spyOn(apiClient.auth, 'login').mockRejectedValue(
      new ApiError('Invalid credentials', 401, 'INVALID_CREDENTIALS'),
    );

    await submitLogin({ username: 'user', password: 'wrong' });

    expect(toast.warning).not.toHaveBeenCalled();
  });
});

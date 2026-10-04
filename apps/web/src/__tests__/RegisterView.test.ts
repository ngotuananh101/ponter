import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import RegisterView from '@/views/RegisterView.vue';
import { useAuthStore } from '@/stores/auth';

describe('RegisterView.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('shows success banner when auth store requiresApproval is true', async () => {
    const wrapper = mount(RegisterView, {
      global: {
        stubs: { RouterLink: true },
      },
    });

    // After onMounted runs clearError(), simulate a pending-approval
    // registration by setting the flag on the store the component uses.
    useAuthStore().requiresApproval = true;
    useAuthStore().error = null;
    useAuthStore().user = null;

    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Đăng ký thành công');
  });

  it('does NOT show success banner when requiresApproval is false (registration failure)', async () => {
    const wrapper = mount(RegisterView, {
      global: {
        stubs: { RouterLink: true },
      },
    });

    // Simulate a 409/403 rejection: requiresApproval is false, error is set.
    const store = useAuthStore();
    store.requiresApproval = false;
    store.error = 'Username already taken';
    store.user = null;
    store.status = 'error';

    await wrapper.vm.$nextTick();

    expect(wrapper.text()).not.toContain('Đăng ký thành công');
  });
});

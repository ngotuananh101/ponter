import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import RegisterForm from '@/components/auth/RegisterForm.vue';

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { toast } from 'vue-sonner';

describe('RegisterForm.vue', () => {
  it('19. A mismatched password confirmation calls toast.error and does not emit', async () => {
    const wrapper = mount(RegisterForm, {
      global: { stubs: { RouterLink: true } },
    });
    await wrapper.find('#reg-username').setValue('alice');
    await wrapper.find('#reg-password').setValue('password123');
    await wrapper.find('#reg-confirm-password').setValue('password456');
    await wrapper.find('form').trigger('submit.prevent');

    expect(toast.error).toHaveBeenCalledWith('Passwords do not match');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('20. A password shorter than 8 characters calls toast.error', async () => {
    const wrapper = mount(RegisterForm, {
      global: { stubs: { RouterLink: true } },
    });
    await wrapper.find('#reg-username').setValue('alice');
    await wrapper.find('#reg-password').setValue('short');
    await wrapper.find('#reg-confirm-password').setValue('short');
    await wrapper.find('form').trigger('submit.prevent');

    expect(toast.error).toHaveBeenCalledWith(
      'Password must be at least 8 characters',
    );
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('21. A malformed email calls toast.error', async () => {
    const wrapper = mount(RegisterForm, {
      global: { stubs: { RouterLink: true } },
    });
    await wrapper.find('#reg-username').setValue('alice');
    await wrapper.find('#reg-email').setValue('not-an-email');
    await wrapper.find('#reg-password').setValue('password123');
    await wrapper.find('#reg-confirm-password').setValue('password123');
    await wrapper.find('form').trigger('submit.prevent');

    expect(toast.error).toHaveBeenCalledWith(
      'Please enter a valid email address',
    );
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('22. A valid form emits submit with entered fields', async () => {
    const wrapper = mount(RegisterForm, {
      global: { stubs: { RouterLink: true } },
    });
    await wrapper.find('#reg-username').setValue('alice');
    await wrapper.find('#reg-email').setValue('alice@example.com');
    await wrapper.find('#reg-password').setValue('password123');
    await wrapper.find('#reg-confirm-password').setValue('password123');
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.emitted('submit')).toHaveLength(1);
    expect(wrapper.emitted('submit')![0]).toEqual([
      {
        username: 'alice',
        email: 'alice@example.com',
        password: 'password123',
      },
    ]);
  });
});

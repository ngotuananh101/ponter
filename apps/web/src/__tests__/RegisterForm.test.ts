import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import RegisterForm from '@/components/auth/RegisterForm.vue';

describe('RegisterForm.vue', () => {
  it('19. A mismatched password confirmation shows an error and does not emit', async () => {
    const wrapper = mount(RegisterForm, {
      global: { stubs: { RouterLink: true } },
    });
    await wrapper.find('#reg-username').setValue('alice');
    await wrapper.find('#reg-password').setValue('password123');
    await wrapper.find('#reg-confirm-password').setValue('password456');
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.text()).toContain('Passwords do not match');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('20. A password shorter than 8 characters shows an error', async () => {
    const wrapper = mount(RegisterForm, {
      global: { stubs: { RouterLink: true } },
    });
    await wrapper.find('#reg-username').setValue('alice');
    await wrapper.find('#reg-password').setValue('short');
    await wrapper.find('#reg-confirm-password').setValue('short');
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.text()).toContain('Password must be at least 8 characters');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('21. A malformed email shows an error', async () => {
    const wrapper = mount(RegisterForm, {
      global: { stubs: { RouterLink: true } },
    });
    await wrapper.find('#reg-username').setValue('alice');
    await wrapper.find('#reg-email').setValue('not-an-email');
    await wrapper.find('#reg-password').setValue('password123');
    await wrapper.find('#reg-confirm-password').setValue('password123');
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.text()).toContain('Please enter a valid email address');
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

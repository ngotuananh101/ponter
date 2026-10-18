import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import LoginForm from './LoginForm.vue';

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { toast } from 'vue-sonner';

describe('LoginForm.vue', () => {
  it('16. Submitting empty fields calls toast.error with validation message and emits nothing', async () => {
    const wrapper = mount(LoginForm, {
      global: { stubs: { RouterLink: true } },
    });
    await wrapper.find('form').trigger('submit.prevent');

    expect(toast.error).toHaveBeenCalledWith(
      'Please enter both username and password',
    );
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('17. A valid submit emits submit event with entered credentials', async () => {
    const wrapper = mount(LoginForm, {
      global: { stubs: { RouterLink: true } },
    });
    await wrapper.find('#username').setValue('alice');
    await wrapper.find('#password').setValue('password123');
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.emitted('submit')).toHaveLength(1);
    expect(wrapper.emitted('submit')![0]).toEqual([
      { username: 'alice', password: 'password123', rememberMe: true },
    ]);
  });

  it('20. Remember me checkbox defaults to checked and can be unchecked', async () => {
    const wrapper = mount(LoginForm, {
      global: { stubs: { RouterLink: true } },
    });
    const checkbox = wrapper.find('#remember-me');
    expect(checkbox.exists()).toBe(true);
    expect(
      checkbox.attributes('aria-checked') === 'true' ||
        (checkbox.element as HTMLInputElement).checked === true,
    ).toBe(true);

    await wrapper.find('#username').setValue('bob');
    await wrapper.find('#password').setValue('secret123');
    await checkbox.trigger('click');
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.emitted('submit')).toHaveLength(1);
    expect(wrapper.emitted('submit')![0]).toEqual([
      { username: 'bob', password: 'secret123', rememberMe: false },
    ]);
  });

  it('18. Submit button is disabled while loading', () => {
    const wrapper = mount(LoginForm, {
      props: { loading: true },
      global: { stubs: { RouterLink: true } },
    });

    const submitBtn = wrapper.find('button[type="submit"]');
    expect(submitBtn.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('Signing in...');
  });

  it('19. Submitting whitespace-only username calls toast.error with validation message and emits nothing', async () => {
    const wrapper = mount(LoginForm, {
      global: { stubs: { RouterLink: true } },
    });
    await wrapper.find('#username').setValue('   ');
    await wrapper.find('#password').setValue('password123');
    await wrapper.find('form').trigger('submit.prevent');

    expect(toast.error).toHaveBeenCalledWith(
      'Please enter both username and password',
    );
    expect(wrapper.emitted('submit')).toBeUndefined();
  });
});

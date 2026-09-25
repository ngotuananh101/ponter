import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import LoginForm from '@/components/auth/LoginForm.vue';

describe('LoginForm.vue', () => {
  it('16. Submitting empty fields shows validation message and emits nothing', async () => {
    const wrapper = mount(LoginForm, {
      global: { stubs: { RouterLink: true } },
    });
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.text()).toContain('Please enter both username and password');
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
      { username: 'alice', password: 'password123' },
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

  it('19. Submitting whitespace-only username shows validation message and emits nothing', async () => {
    const wrapper = mount(LoginForm, {
      global: { stubs: { RouterLink: true } },
    });
    await wrapper.find('#username').setValue('   ');
    await wrapper.find('#password').setValue('password123');
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.text()).toContain('Please enter both username and password');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });
});

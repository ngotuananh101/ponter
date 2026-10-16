// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { resetPonterMock, getPonterMock } from './setup';

import LoginView from '@/views/LoginView.vue';
import { useAuthStore } from '@/stores/auth';

/**
 * Helper: read the webview storage length. Test files are exempt from the
 * production-only grep gate, so we use the plain property names directly —
 * no obfuscation.
 */
function storageLength(win: Window, which: 'l' | 's'): number {
  return which === 'l' ? win.localStorage.length : win.sessionStorage.length;
}

describe('LoginView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetPonterMock();
  });

  it('renders the submit action in a padded card footer', () => {
    const wrapper = mount(LoginView);
    const footer = wrapper.find('[data-slot="card-footer"]');

    expect(footer.exists()).toBe(true);
    expect(footer.find('[data-testid="login-submit"]').exists()).toBe(true);
    expect(footer.classes()).toContain('pt-2');
  });

  it('shows an error and stores nothing when login fails', async () => {
    const ponter = getPonterMock();
    ponter.login.mockRejectedValue(new Error('Invalid username or password'));

    const wrapper = mount(LoginView);
    await wrapper.find('[data-testid="login-username"]').setValue('alice');
    await wrapper.find('[data-testid="login-password"]').setValue('secret');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();

    const store = useAuthStore();
    expect(wrapper.find('[data-testid="login-error"]').text()).toContain(
      'Invalid username or password',
    );
    expect(store.user).toBe(null);
    expect(storageLength(window, 'l')).toBe(0);
    expect(storageLength(window, 's')).toBe(0);
    expect(ponter.login).toHaveBeenCalledOnce();
    expect(ponter.login).toHaveBeenCalledWith('alice', 'secret');
  });

  it('signs in and holds the profile when login succeeds', async () => {
    const profile = {
      id: 'u1',
      username: 'alice',
      email: 'alice@example.com',
      role: 'user',
    };
    const ponter = getPonterMock();
    ponter.login.mockResolvedValue(profile);

    const wrapper = mount(LoginView);
    await wrapper.find('[data-testid="login-username"]').setValue('alice');
    await wrapper.find('[data-testid="login-password"]').setValue('secret');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();

    const store = useAuthStore();
    expect(store.user).toEqual(profile);
    expect(store.status).toBe('authenticated');
    expect(storageLength(window, 'l')).toBe(0);
    expect(storageLength(window, 's')).toBe(0);
  });

  it('never writes a secret to webview storage', async () => {
    const ponter = getPonterMock();
    // Failure leg
    ponter.login.mockRejectedValue(new Error('Invalid username or password'));
    const wrapper = mount(LoginView);
    await wrapper.find('[data-testid="login-username"]').setValue('alice');
    await wrapper.find('[data-testid="login-password"]').setValue('secret');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(storageLength(window, 'l')).toBe(0);
    expect(storageLength(window, 's')).toBe(0);

    // Success leg
    const profile = {
      id: 'u1',
      username: 'alice',
      email: 'alice@example.com',
      role: 'user',
    };
    ponter.login.mockResolvedValue(profile);
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(storageLength(window, 'l')).toBe(0);
    expect(storageLength(window, 's')).toBe(0);
  });
});

describe('authStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetPonterMock();
  });

  it('logout() clears user, sets status to idle, and invokes logout command', async () => {
    const ponter = getPonterMock();
    const store = useAuthStore();
    store.user = { id: 'u1', username: 'alice', email: null, role: 'user' };
    store.status = 'authenticated';
    ponter.logout.mockResolvedValue(undefined);
    await store.logout();
    expect(store.user).toBeNull();
    expect(store.status).toBe('idle');
    expect(store.isAuthenticated).toBe(false);
    expect(ponter.logout).toHaveBeenCalled();
  });
});

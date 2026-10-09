import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@tauri-apps/api/core', () => {
  const fn = vi.fn();
  return { __esModule: true, invoke: fn, default: { invoke: fn } };
});

import { invoke } from '@tauri-apps/api/core';
import App from '@/App.vue';
import { useAuthStore } from '@/stores/auth';
import { useConfigStore } from '@/stores/config';
import { useWizardStore } from '@/stores/wizard';

async function mountApp() {
  const wrapper = mount(App, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

describe('App flow (ADR-66)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_devices') return Promise.resolve([]);
      if (cmd === 'is_autostart_enabled') return Promise.resolve(false);
      return Promise.resolve({
        serverUrl: null,
        allowInput: false,
        theme: null,
        hasServerUrl: false,
      });
    });
  });

  it('renders the centered utility window shell', async () => {
    const wrapper = await mountApp();
    expect(wrapper.find('[data-testid="app-shell"]').exists()).toBe(true);
  });

  it('shows ServerSetupView when no server is configured', async () => {
    const wrapper = await mountApp();
    expect(wrapper.find('[data-testid="server-setup-root"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('[data-testid="login-username"]').exists()).toBe(false);
  });

  it('shows LoginView when a server is configured but unauthenticated', async () => {
    const wrapper = await mountApp();
    const config = useConfigStore();
    config.hasServerUrl = true;
    await flushPromises();
    expect(wrapper.find('[data-testid="login-username"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="server-setup-root"]').exists()).toBe(
      false,
    );
  });

  it('shows WizardView when authenticated but the wizard is incomplete', async () => {
    const wrapper = await mountApp();
    const config = useConfigStore();
    config.hasServerUrl = true;
    const auth = useAuthStore();
    auth.user = { id: 'u1', username: 'a', role: 'user' };
    auth.status = 'authenticated';
    await flushPromises();
    expect(wrapper.find('[data-testid="wizard-root"]').exists()).toBe(true);
  });

  it('shows DevicesView when the wizard is complete', async () => {
    const wrapper = await mountApp();
    const config = useConfigStore();
    config.hasServerUrl = true;
    const auth = useAuthStore();
    auth.user = { id: 'u1', username: 'a', role: 'user' };
    auth.status = 'authenticated';
    const wizard = useWizardStore();
    wizard.completed = true;
    await flushPromises();
    expect(wrapper.find('[data-testid="wizard-root"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="devices-root"]').exists()).toBe(true);
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { resetPonterMock, getPonterMock } from './setup';

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
    const ponter = getPonterMock();
    // Default: no server configured, no devices, autostart off.
    ponter.getConfig.mockResolvedValue({
      serverUrl: null,
      allowInput: false,
      theme: null,
      hasServerUrl: false,
    });
    ponter.listDevices.mockResolvedValue([]);
    ponter.isAutostartEnabled.mockResolvedValue(false);
  });

  it('renders the centered utility window shell with vertical scroll support', async () => {
    const wrapper = await mountApp();
    const shell = wrapper.find('[data-testid="app-shell"]');
    expect(shell.exists()).toBe(true);
    expect(shell.classes()).toContain('overflow-y-auto');
    expect(shell.classes()).toContain('overflow-x-hidden');
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

  it('renders nothing but the shell until configLoaded resolves, then routes', async () => {
    // Make `getConfig` pending so configLoaded stays false past the first tick.
    let resolveGetConfig: (v: unknown) => void = () => {};
    const ponter = getPonterMock();
    ponter.getConfig.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetConfig = resolve;
        }),
    );

    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();

    // While getConfig is unresolved, NO view should be mounted.
    expect(wrapper.find('[data-testid="server-setup-root"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('[data-testid="login-username"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="wizard-root"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="devices-root"]').exists()).toBe(false);
    // The neutral shell background is present, but the routing placeholder is visible.
    expect(wrapper.find('[data-testid="app-shell"]').exists()).toBe(true);

    // Resolve config load with a configured-but-unauthenticated server.
    resolveGetConfig({
      serverUrl: null,
      allowInput: false,
      theme: null,
      hasServerUrl: true,
    });
    await flushPromises();

    // After load resolves, routing kicks in: a server is configured but the user
    // is unauthenticated, so LoginView appears (not ServerSetupView).
    expect(wrapper.find('[data-testid="login-username"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="server-setup-root"]').exists()).toBe(
      false,
    );

    wrapper.unmount();
  });

  it('still routes after a config load failure (configLoaded flips on failure)', async () => {
    // D requires `configLoaded` to flip on BOTH success and failure so the gate
    // never stalls. A rejected `getConfig` must still surface the shell and a
    // route.
    const ponter = getPonterMock();
    ponter.getConfig.mockRejectedValue(new Error('config read failed'));

    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();

    const config = useConfigStore();
    expect(config.configLoaded).toBe(true);
    expect(wrapper.find('[data-testid="app-shell"]').exists()).toBe(true);
    // hasServerUrl stayed false → the ServerSetupView route renders.
    expect(wrapper.find('[data-testid="server-setup-root"]').exists()).toBe(
      true,
    );

    wrapper.unmount();
  });

  /**
   * Ticket #156: Auto-restore session on startup when rememberMe was chosen.
   */
  it('restores remembered session on startup and routes directly without showing LoginView', async () => {
    const ponter = getPonterMock();
    ponter.getConfig.mockResolvedValue({
      serverUrl: 'https://ponter.ponta.dev',
      allowInput: true,
      theme: 'dark',
      hasServerUrl: true,
      rememberMe: true,
      savedUsername: 'alice',
    });
    ponter.restoreSession.mockResolvedValue({
      id: 'u1',
      username: 'alice',
      email: 'alice@example.com',
      role: 'admin',
    });

    const wrapper = await mountApp();

    expect(ponter.restoreSession).toHaveBeenCalledTimes(1);
    const auth = useAuthStore();
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.user?.username).toBe('alice');
    // LoginView must NOT be shown
    expect(wrapper.find('[data-testid="login-username"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it('shows LoginView when restoreSession returns null on startup', async () => {
    const ponter = getPonterMock();
    ponter.getConfig.mockResolvedValue({
      serverUrl: 'https://ponter.ponta.dev',
      allowInput: true,
      theme: 'dark',
      hasServerUrl: true,
      rememberMe: false,
    });
    ponter.restoreSession.mockResolvedValue(null);

    const wrapper = await mountApp();

    expect(ponter.restoreSession).toHaveBeenCalledTimes(1);
    const auth = useAuthStore();
    expect(auth.isAuthenticated).toBe(false);
    expect(wrapper.find('[data-testid="login-username"]').exists()).toBe(true);

    wrapper.unmount();
  });
});

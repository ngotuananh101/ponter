// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { resetPonterMock, getPonterMock } from './setup';

import { useConfigStore } from '@/stores/config';
import ServerSetupView from '@/views/ServerSetupView.vue';

/** Storage gate: no webview storage in production frontend code (R8). */
function storageLength(win: Window, which: 'l' | 's'): number {
  return which === 'l' ? win.localStorage.length : win.sessionStorage.length;
}

describe('ServerSetupView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetPonterMock();
  });

  it('renders the server setup with url input and connect button', () => {
    const wrapper = mount(ServerSetupView);
    expect(wrapper.find('[data-testid="server-setup-url"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('[data-testid="server-setup-connect"]').exists()).toBe(
      true,
    );
  });

  it('successful probe calls saveConfig and clears editing', async () => {
    const ponter = getPonterMock();
    const wrapper = mount(ServerSetupView);
    const config = useConfigStore();
    config.editing = true;

    ponter.probeServer.mockResolvedValueOnce({
      ok: true,
      message: 'Server reachable',
    });

    await wrapper
      .find('[data-testid="server-setup-url"]')
      .setValue('http://localhost:8787');
    await wrapper.find('[data-testid="server-setup-connect"]').trigger('click');
    await flushPromises();

    expect(ponter.probeServer).toHaveBeenCalledWith('http://localhost:8787');
    expect(ponter.saveConfig).toHaveBeenCalledWith({
      serverUrl: 'http://localhost:8787',
      allowInput: false,
      theme: null,
    });
    expect(config.editing).toBe(false);
    expect(config.hasServerUrl).toBe(true);
    expect(config.serverUrl).toBe('http://localhost:8787');
  });

  it('failed probe shows the message and does not persist', async () => {
    const ponter = getPonterMock();
    const wrapper = mount(ServerSetupView);
    const config = useConfigStore();

    ponter.probeServer.mockResolvedValue({
      ok: false,
      message: 'Could not reach server: connection refused',
    });

    await wrapper
      .find('[data-testid="server-setup-url"]')
      .setValue('http://dead');
    await wrapper.find('[data-testid="server-setup-connect"]').trigger('click');
    await flushPromises();
    await nextTick();

    expect(
      wrapper.find('[data-testid="server-setup-message"]').text(),
    ).toContain('Could not reach');
    // The saveConfig call should NOT have been made because the probe failed.
    const calls = ponter.saveConfig.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([]);
    expect(config.hasServerUrl).toBe(false);
  });

  it('a failed saveConfig shows an error and does not clear editing', async () => {
    const ponter = getPonterMock();
    const wrapper = mount(ServerSetupView);
    const config = useConfigStore();
    config.editing = true;

    // probeServer succeeds
    ponter.probeServer.mockResolvedValueOnce({
      ok: true,
      message: 'Server reachable',
    });
    // saveConfig rejects
    ponter.saveConfig.mockRejectedValueOnce(new Error('Disk full'));

    await wrapper
      .find('[data-testid="server-setup-url"]')
      .setValue('http://localhost:8787');
    await wrapper.find('[data-testid="server-setup-connect"]').trigger('click');
    await flushPromises();
    await nextTick();

    // An honest error is surfaced via the alert
    expect(wrapper.find('[data-testid="server-setup-message"]').exists()).toBe(
      true,
    );
    expect(
      wrapper.find('[data-testid="server-setup-message"]').text(),
    ).toContain('Disk full');
    // editing must NOT have been cleared on failure
    expect(config.editing).toBe(true);
  });

  it('never writes to webview storage', async () => {
    const ponter = getPonterMock();
    ponter.probeServer.mockResolvedValue({
      ok: true,
      message: 'Server reachable',
    });

    const wrapper = mount(ServerSetupView);
    await wrapper
      .find('[data-testid="server-setup-url"]')
      .setValue('http://localhost:8787');
    await wrapper.find('[data-testid="server-setup-connect"]').trigger('click');
    await flushPromises();

    expect(storageLength(window, 'l')).toBe(0);
    expect(storageLength(window, 's')).toBe(0);
  });
});

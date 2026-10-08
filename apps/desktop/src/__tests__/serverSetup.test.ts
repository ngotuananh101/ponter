import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('@tauri-apps/api/core', () => {
  const fn = vi.fn();
  return {
    __esModule: true,
    invoke: fn,
    default: { invoke: fn },
  };
});

import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '@/stores/config';
import ServerSetupView from '@/views/ServerSetupView.vue';

/** Storage gate: no webview storage in production frontend code (R8). */
function storageLength(win: Window, which: 'l' | 's'): number {
  return which === 'l' ? win.localStorage.length : win.sessionStorage.length;
}

describe('ServerSetupView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({
      serverUrl: null,
      allowInput: false,
      theme: null,
      hasServerUrl: false,
    });
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

  it('successful probe calls save_config and clears editing', async () => {
    const wrapper = mount(ServerSetupView);
    const config = useConfigStore();
    config.editing = true;

    vi.mocked(invoke).mockResolvedValueOnce({
      ok: true,
      message: 'Server reachable',
    });

    await wrapper
      .find('[data-testid="server-setup-url"]')
      .setValue('http://localhost:8787');
    await wrapper.find('[data-testid="server-setup-connect"]').trigger('click');
    await flushPromises();

    expect(invoke).toHaveBeenCalledWith('probe_server', {
      url: 'http://localhost:8787',
    });
    expect(invoke).toHaveBeenCalledWith('save_config', {
      serverUrl: 'http://localhost:8787',
      allowInput: false,
      theme: null,
    });
    expect(config.editing).toBe(false);
    expect(config.hasServerUrl).toBe(true);
    expect(config.serverUrl).toBe('http://localhost:8787');
  });

  it('failed probe shows the message and does not persist', async () => {
    const wrapper = mount(ServerSetupView);
    const config = useConfigStore();

    vi.mocked(invoke).mockResolvedValue({
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
    // The second invoke call (save_config) should NOT have been made because
    // the probe failed.
    const calls = vi.mocked(invoke).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['probe_server']);
    expect(config.hasServerUrl).toBe(false);
  });

  it('never writes to webview storage', async () => {
    vi.mocked(invoke).mockResolvedValue({
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

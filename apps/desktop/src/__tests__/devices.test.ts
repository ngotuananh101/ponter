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
import { useDevicesStore } from '@/stores/devices';
import { useAuthStore } from '@/stores/auth';
import DevicesView from '@/views/DevicesView.vue';

/** Storage gate: no webview storage in production frontend code. */
function storageLength(win: Window, which: 'l' | 's'): number {
  return which === 'l' ? win.localStorage.length : win.sessionStorage.length;
}

const sampleDevice = {
  id: 'mybox-a1b2c3d4',
  userId: 'u1',
  hostname: 'mybox',
  platform: 'linux',
  osVersion: 'unknown',
  agentVersion: '0.1.0',
  publicKey: '',
  signingPublicKey: null,
  isOnline: false,
  lastHeartbeat: null,
  capabilities: [],
  createdAt: '2026-10-08T00:00:00Z',
};

describe('devices store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
  });

  it('defaults to empty with no error', () => {
    const store = useDevicesStore();
    expect(store.devices).toEqual([]);
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.registered).toBe(false);
  });

  it('refresh() populates devices', async () => {
    vi.mocked(invoke).mockResolvedValue([sampleDevice]);

    const store = useDevicesStore();
    await store.refresh();

    expect(invoke).toHaveBeenCalledWith('list_devices');
    expect(store.devices).toHaveLength(1);
    expect(store.devices[0].id).toBe('mybox-a1b2c3d4');
    expect(store.loading).toBe(false);
  });

  it('refresh() sets error on failure', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('network down'));

    const store = useDevicesStore();
    await store.refresh();

    expect(store.error).toBe('network down');
    expect(store.devices).toEqual([]);
  });

  it('register() calls invoke and marks registered', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(sampleDevice) // register_device
      .mockResolvedValueOnce([sampleDevice]); // list_devices (refresh)

    const store = useDevicesStore();
    const result = await store.register();

    expect(result).toEqual(sampleDevice);
    expect(store.registered).toBe(true);
    // The register result must never carry a credential field.
    expect(result).not.toHaveProperty('credential');
    expect(invoke).toHaveBeenCalledWith('register_device');
  });

  it('register() surfaces error without marking registered', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('AGENT_LIMIT_REACHED'));

    const store = useDevicesStore();
    const result = await store.register();

    expect(result).toBeNull();
    expect(store.registered).toBe(false);
    expect(store.error).toBe('AGENT_LIMIT_REACHED');
  });

  it('remove() deletes and removes the row', async () => {
    vi.mocked(invoke).mockResolvedValue(true);

    const store = useDevicesStore();
    store.devices = [sampleDevice];
    const ok = await store.remove('mybox-a1b2c3d4');

    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('delete_device', {
      agentId: 'mybox-a1b2c3d4',
    });
    expect(store.devices).toHaveLength(0);
  });

  it('remove() surfaces error on failure', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('Agent not found'));

    const store = useDevicesStore();
    const ok = await store.remove('dev-missing');

    expect(ok).toBe(false);
    expect(store.error).toBe('Agent not found');
  });
});

describe('DevicesView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
  });

  it('renders empty state when no devices', async () => {
    vi.mocked(invoke).mockResolvedValue([]);

    const wrapper = mount(DevicesView);
    await flushPromises();
    await nextTick();

    const empty = wrapper.find('[data-testid="devices-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain('No devices registered yet');
  });

  it('renders device rows after refresh', async () => {
    vi.mocked(invoke).mockResolvedValue([sampleDevice]);

    const wrapper = mount(DevicesView);
    await flushPromises();
    await nextTick();

    const rows = wrapper.findAll('[data-testid="device-row"]');
    expect(rows).toHaveLength(1);
    expect(wrapper.find('[data-testid="device-id"]').text()).toBe(
      sampleDevice.id,
    );
    expect(wrapper.find('[data-testid="device-hostname"]').text()).toBe(
      sampleDevice.hostname,
    );
  });

  it('register button calls store.register', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'register_device') return sampleDevice;
      if (cmd === 'list_devices') return [];
      return undefined;
    });

    const wrapper = mount(DevicesView);
    await flushPromises();
    await nextTick();

    await wrapper.find('[data-testid="devices-register"]').trigger('click');
    await flushPromises();

    expect(invoke).toHaveBeenCalledWith('register_device');
  });

  it('delete button calls store.remove with confirmation', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_devices') return [sampleDevice];
      if (cmd === 'delete_device') return true;
      return undefined;
    });

    const wrapper = mount(DevicesView, {
      global: {
        stubs: {
          Teleport: { template: '<slot />' },
        },
      },
    });
    await flushPromises();
    await nextTick();

    const store = useDevicesStore();
    const removeSpy = vi.spyOn(store, 'remove');

    await wrapper.find('[data-testid="device-delete"]').trigger('click');
    await flushPromises();
    await nextTick();

    const deleteBtn = wrapper.find('[data-slot="alert-dialog-action"]');
    expect(deleteBtn.exists()).toBe(true);

    await deleteBtn.trigger('click');
    await flushPromises();

    expect(removeSpy).toHaveBeenCalledWith(sampleDevice.id);
    expect(invoke).toHaveBeenCalledWith('delete_device', {
      agentId: sampleDevice.id,
    });
    wrapper.unmount();
  });

  it('never writes a credential or secret to webview storage', async () => {
    // Mock per-command-name to avoid call-order coupling with onMounted.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'register_device') return sampleDevice;
      if (cmd === 'list_devices') return [];
      return undefined;
    });

    const wrapper = mount(DevicesView);
    await flushPromises();
    await nextTick();

    await wrapper.find('[data-testid="devices-register"]').trigger('click');
    await flushPromises();
    await nextTick();

    expect(storageLength(window, 'l')).toBe(0);
    expect(storageLength(window, 's')).toBe(0);

    // The register result must never carry a credential field.
    const store = useDevicesStore();
    expect(store.registered).toBe(true);
    expect(store.devices).toHaveLength(0);
  });

  it('logout button triggers authStore.logout', async () => {
    vi.mocked(invoke).mockResolvedValue([]);

    const authStore = useAuthStore();
    const logoutSpy = vi
      .spyOn(authStore, 'logout')
      .mockResolvedValue(undefined);

    const wrapper = mount(DevicesView);
    await flushPromises();
    await nextTick();

    const logoutBtn = wrapper.find('[data-testid="devices-logout"]');
    expect(logoutBtn.exists()).toBe(true);
    await logoutBtn.trigger('click');

    expect(logoutSpy).toHaveBeenCalled();
  });
});

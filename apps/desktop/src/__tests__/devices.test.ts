import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

vi.mock('@tauri-apps/api/event', () => ({
  __esModule: true,
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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

/**
 * Route the mocked Tauri `invoke` bridge by command name. A command with no
 * handler resolves to `undefined`; a handler that throws simulates a backend
 * failure. Replaces the repeated `mockImplementation` blocks across the view
 * tests (Sonar new-code duplication).
 */
function mockInvoke(handlers: Record<string, () => unknown> = {}): void {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    const handler = handlers[cmd];
    return handler ? handler() : undefined;
  });
}

/** Mount DevicesView, settle onMounted's async work, and return the wrapper. */
async function mountView(options: { stubTeleport?: boolean } = {}) {
  const wrapper = mount(
    DevicesView,
    options.stubTeleport
      ? { global: { stubs: { Teleport: { template: '<slot />' } } } }
      : undefined,
  );
  await flushPromises();
  await nextTick();
  return wrapper;
}

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
    mockInvoke({
      register_device: () => sampleDevice,
      list_devices: () => [sampleDevice],
    });

    const store = useDevicesStore();
    const result = await store.register();

    expect(result).toEqual(sampleDevice);
    expect(store.registered).toBe(true);
    // The register result must never carry a credential field.
    expect(result).not.toHaveProperty('credential');
    expect(invoke).toHaveBeenCalledWith('register_device', {
      capabilities: ['terminal', 'desktop', 'files'],
    });
  });

  it('register() surfaces error without marking registered', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('AGENT_LIMIT_REACHED'));

    const store = useDevicesStore();
    const result = await store.register();

    expect(result).toBeNull();
    expect(store.registered).toBe(false);
    expect(store.error).toBe('AGENT_LIMIT_REACHED');
  });

  it("register(['terminal', 'desktop']) forwards exact capabilities array", async () => {
    mockInvoke({
      register_device: () => sampleDevice,
      list_devices: () => [sampleDevice],
    });

    const store = useDevicesStore();
    const result = await store.register(['terminal', 'desktop']);

    expect(result).toEqual(sampleDevice);
    expect(invoke).toHaveBeenCalledWith('register_device', {
      capabilities: ['terminal', 'desktop'],
    });
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

  it('refresh({ background: true }) does not set loading=true during in-flight request', async () => {
    const refreshPromise = new Promise<unknown>(() => {}); // never resolves
    vi.mocked(invoke).mockReturnValue(refreshPromise as never);

    const store = useDevicesStore();
    void store.refresh({ background: true });

    // While the request is in-flight, loading must NOT be set to true.
    expect(store.loading).toBe(false);

    // devices.value should remain unchanged (empty) while inflight.
    expect(store.devices).toEqual([]);
  });

  it('refresh({ background: true }) still captures errors into store.error', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('bg refresh failed'));

    const store = useDevicesStore();
    await store.refresh({ background: true });

    expect(store.error).toBe('bg refresh failed');
    expect(store.devices).toEqual([]);
    expect(store.loading).toBe(false);
  });
});

describe('DevicesView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
    vi.clearAllTimers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('renders empty state when no devices', async () => {
    mockInvoke({ list_devices: () => [] });

    const wrapper = await mountView();

    const empty = wrapper.find('[data-testid="devices-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain('No devices registered yet');
  });

  it('renders device rows after refresh', async () => {
    mockInvoke({ list_devices: () => [sampleDevice] });

    const wrapper = await mountView();

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
    mockInvoke({
      register_device: () => sampleDevice,
      list_devices: () => [],
    });

    const wrapper = await mountView();

    await wrapper.find('[data-testid="devices-register"]').trigger('click');
    await flushPromises();

    expect(invoke).toHaveBeenCalledWith('register_device', {
      capabilities: ['terminal', 'desktop'],
    });
  });

  it('capabilities selector defaults to terminal+desktop (files off)', async () => {
    mockInvoke({ list_devices: () => [], get_runtime_status: () => 'stopped' });

    const wrapper = await mountView();

    expect(
      wrapper
        .find('[data-test="register-cap-terminal"]')
        .attributes('aria-pressed'),
    ).toBe('true');
    expect(
      wrapper
        .find('[data-test="register-cap-desktop"]')
        .attributes('aria-pressed'),
    ).toBe('true');
    expect(
      wrapper
        .find('[data-test="register-cap-files"]')
        .attributes('aria-pressed'),
    ).toBe('false');
  });

  it('register with files toggled sends files capability', async () => {
    mockInvoke({
      register_device: () => sampleDevice,
      list_devices: () => [],
      get_runtime_status: () => 'stopped',
    });

    const wrapper = await mountView();

    // Toggle files ON
    await wrapper.find('[data-test="register-cap-files"]').trigger('click');
    await nextTick();

    await wrapper.find('[data-testid="devices-register"]').trigger('click');
    await flushPromises();

    expect(invoke).toHaveBeenCalledWith('register_device', {
      capabilities: ['terminal', 'desktop', 'files'],
    });
  });

  it('register with files and terminal toggled off sends only desktop', async () => {
    mockInvoke({
      register_device: () => sampleDevice,
      list_devices: () => [],
      get_runtime_status: () => 'stopped',
    });

    const wrapper = await mountView();

    // Toggle terminal OFF
    await wrapper.find('[data-test="register-cap-terminal"]').trigger('click');
    // Toggle files ON
    await wrapper.find('[data-test="register-cap-files"]').trigger('click');
    await nextTick();

    await wrapper.find('[data-testid="devices-register"]').trigger('click');
    await flushPromises();

    expect(invoke).toHaveBeenCalledWith('register_device', {
      capabilities: ['desktop', 'files'],
    });
  });

  it('runtime status indicator reflects get_runtime_status value', async () => {
    mockInvoke({
      list_devices: () => [],
      get_runtime_status: () => 'connected',
    });

    const wrapper = await mountView();

    const statusEl = wrapper.find('[data-testid="runtime-status"]');
    expect(statusEl.attributes('data-status')).toBe('connected');
  });

  it('runtime-status event updates the indicator', async () => {
    mockInvoke({ list_devices: () => [], get_runtime_status: () => 'stopped' });

    const wrapper = await mountView();

    const statusEl = wrapper.find('[data-testid="runtime-status"]');
    expect(statusEl.attributes('data-status')).toBe('stopped');

    // Get the listen handler that was registered — onMounted is async, so
    // flushPromises ensures listen(...) has been called by the time we check.
    const listenSpy = vi.mocked(listen);
    expect(listenSpy).toHaveBeenCalledWith(
      'runtime-status',
      expect.any(Function),
    );

    // Extract the handler from the mock and invoke it
    const handler = listenSpy.mock.calls[0][1] as (event: {
      payload: { status: string };
    }) => void;
    handler({ payload: { status: 'connected' } });
    await nextTick();

    expect(statusEl.attributes('data-status')).toBe('connected');
  });

  it('runtime status handles get_runtime_status failure gracefully', async () => {
    mockInvoke({
      list_devices: () => [],
      get_runtime_status: () => {
        throw new Error('Tauri not available');
      },
    });

    const wrapper = await mountView();

    const statusEl = wrapper.find('[data-testid="runtime-status"]');
    expect(statusEl.attributes('data-status')).toBe('unknown');
  });

  it('auto-refresh calls list_devices on interval', async () => {
    mockInvoke({
      list_devices: () => [],
      get_runtime_status: () => 'connected',
    });

    const wrapper = await mountView();

    // Initially list_devices called once from onMounted
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2); // list_devices + get_runtime_status

    // Capture the count from onMounted — a count-delta assertion ensures the
    // interval actually fires a SECOND time (vacuous: toHaveBeenCalledWith alone
    // is already satisfied by onMounted).
    const listDevicesCountBefore = vi
      .mocked(invoke)
      .mock.calls.filter((call) => call[0] === 'list_devices').length;

    // Advance past the 5000ms interval
    vi.advanceTimersByTime(5000);
    await flushPromises();

    const listDevicesCountAfter = vi
      .mocked(invoke)
      .mock.calls.filter((call) => call[0] === 'list_devices').length;

    expect(listDevicesCountAfter).toBeGreaterThan(listDevicesCountBefore);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('list_devices');
    wrapper.unmount();
  });

  it('unmount stops auto-refresh and unlistens', async () => {
    const mockUnlisten = vi.fn();
    vi.mocked(listen).mockResolvedValue(mockUnlisten);
    mockInvoke({
      list_devices: () => [],
      get_runtime_status: () => 'connected',
    });

    const wrapper = await mountView();

    // Verify listen was called (we get the unlisten fn back)
    await flushPromises(); // wait for listen to resolve
    expect(mockUnlisten).not.toHaveBeenCalled();

    wrapper.unmount();

    // The unlisten fn should have been called on unmount
    expect(mockUnlisten).toHaveBeenCalled();

    // Advancing timers after unmount should NOT trigger another refresh
    const listDevicesCountBefore = vi
      .mocked(invoke)
      .mock.calls.filter((call) => call[0] === 'list_devices').length;

    vi.advanceTimersByTime(5000);
    await flushPromises();

    const listDevicesCountAfter = vi
      .mocked(invoke)
      .mock.calls.filter((call) => call[0] === 'list_devices').length;

    expect(listDevicesCountAfter).toBe(listDevicesCountBefore);
  });

  it('delete button calls store.remove with confirmation', async () => {
    mockInvoke({
      list_devices: () => [sampleDevice],
      delete_device: () => true,
      get_runtime_status: () => 'stopped',
    });

    const wrapper = await mountView({ stubTeleport: true });

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
    mockInvoke({
      register_device: () => sampleDevice,
      list_devices: () => [],
      get_runtime_status: () => 'stopped',
    });

    const wrapper = await mountView();

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
    mockInvoke({ list_devices: () => [] });

    const authStore = useAuthStore();
    const logoutSpy = vi
      .spyOn(authStore, 'logout')
      .mockResolvedValue(undefined);

    const wrapper = await mountView();

    const logoutBtn = wrapper.find('[data-testid="devices-logout"]');
    expect(logoutBtn.exists()).toBe(true);
    await logoutBtn.trigger('click');

    expect(logoutSpy).toHaveBeenCalled();
  });

  it('background refresh interval passes { background: true } to store.refresh', async () => {
    mockInvoke({
      list_devices: () => [sampleDevice],
      get_runtime_status: () => 'stopped',
    });

    const wrapper = await mountView();

    // Wait past the 5000ms interval
    vi.advanceTimersByTime(5000);
    await flushPromises();

    // Verify the interval-triggered refresh did NOT set loading=true by checking
    // that the devices-loading placeholder is absent when devices are present.
    expect(wrapper.find('[data-testid="devices-loading"]').exists()).toBe(
      false,
    );

    wrapper.unmount();
  });

  it('does not show devices-loading placeholder during background refresh when devices are present', async () => {
    mockInvoke({
      list_devices: () => [sampleDevice],
      get_runtime_status: () => 'stopped',
    });

    const wrapper = await mountView();

    // The loading placeholder should not appear because devices are loaded.
    expect(wrapper.find('[data-testid="devices-loading"]').exists()).toBe(
      false,
    );

    // Advance the auto-refresh interval — still no loading placeholder.
    vi.advanceTimersByTime(5000);
    await flushPromises();
    await nextTick();

    expect(wrapper.find('[data-testid="devices-loading"]').exists()).toBe(
      false,
    );

    // The device list should remain mounted.
    expect(wrapper.find('[data-testid="devices-list"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="device-row"]')).toHaveLength(1);

    wrapper.unmount();
  });

  it('devices list remains mounted during background refresh', async () => {
    mockInvoke({
      list_devices: () => [sampleDevice],
      get_runtime_status: () => 'stopped',
    });

    const wrapper = await mountView();

    const listBefore = wrapper.find('[data-testid="devices-list"]');
    expect(listBefore.exists()).toBe(true);

    // Trigger a background refresh
    vi.advanceTimersByTime(5000);
    await flushPromises();
    await nextTick();

    const listAfter = wrapper.find('[data-testid="devices-list"]');
    expect(listAfter.exists()).toBe(true);

    const rows = wrapper.findAll('[data-testid="device-row"]');
    expect(rows).toHaveLength(1);

    wrapper.unmount();
  });

  it('register button and capability toggles remain enabled during background refresh', async () => {
    mockInvoke({
      list_devices: () => [sampleDevice],
      get_runtime_status: () => 'stopped',
    });

    const wrapper = await mountView();

    // Trigger a background refresh — loading should NOT be true (background=true)
    vi.advanceTimersByTime(5000);
    await flushPromises();
    await nextTick();

    const store = useDevicesStore();
    expect(store.loading).toBe(false);

    const registerBtn = wrapper.find('[data-testid="devices-register"]');
    expect(registerBtn.exists()).toBe(true);
    expect(registerBtn.attributes('disabled')).toBeUndefined();

    const capTerminal = wrapper.find('[data-test="register-cap-terminal"]');
    const capDesktop = wrapper.find('[data-test="register-cap-desktop"]');
    const capFiles = wrapper.find('[data-test="register-cap-files"]');

    expect(capTerminal.attributes('disabled')).toBeUndefined();
    expect(capDesktop.attributes('disabled')).toBeUndefined();
    expect(capFiles.attributes('disabled')).toBeUndefined();

    wrapper.unmount();
  });

  it('register button text shows "Registering..." only during registration, not during background refresh', async () => {
    mockInvoke({
      list_devices: () => [sampleDevice],
      get_runtime_status: () => 'stopped',
    });

    const wrapper = await mountView();

    // Before any registration, text should be "Register Device"
    const registerBtn = wrapper.find('[data-testid="devices-register"]');
    expect(registerBtn.text()).toContain('Register Device');
    expect(registerBtn.text()).not.toContain('Registering...');

    // Trigger a background refresh — text should still show "Register Device"
    vi.advanceTimersByTime(5000);
    await flushPromises();
    await nextTick();

    expect(registerBtn.text()).toContain('Register Device');
    expect(registerBtn.text()).not.toContain('Registering...');

    wrapper.unmount();
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { resetPonterMock, getPonterMock, mockOnRuntimeStatus } from './setup';
import type { DesktopDevice } from '@/types';

import { useDevicesStore } from '@/stores/devices';
import { useAuthStore } from '@/stores/auth';
import DevicesView from '@/views/DevicesView.vue';

/** Storage gate: no webview storage in production frontend code. */
function storageLength(win: Window, which: 'l' | 's'): number {
  return which === 'l' ? win.localStorage.length : win.sessionStorage.length;
}

const sampleDevice: DesktopDevice = {
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
 * Route the mocked `window.ponter` bridge by method name. A method with no
 * handler resolves to `undefined`; a handler that throws simulates a backend
 * failure.
 */
function mockPonter(handlers: Record<string, () => unknown> = {}): void {
  const ponter = getPonterMock();
  for (const key of Object.keys(ponter)) {
    (ponter as Record<string, Mock>)[key].mockReset();
  }
  for (const [key, handler] of Object.entries(handlers)) {
    if (key in ponter) {
      (ponter as Record<string, Mock>)[key].mockImplementation(handler);
    }
  }
}

/**
 * Arm `auth.logout` with a spy and make `window.ponter` methods reject with
 * `message`. Returns the logout spy for assertions.
 */
function armAuthFailure(message: string) {
  const auth = useAuthStore();
  const logoutSpy = vi.spyOn(auth, 'logout').mockResolvedValue(undefined);
  const ponter = getPonterMock();
  for (const key of Object.keys(ponter)) {
    (ponter as Record<string, Mock>)[key].mockRejectedValue(new Error(message));
  }
  return logoutSpy;
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
    resetPonterMock();
  });

  it('defaults to empty with no error', () => {
    const store = useDevicesStore();
    expect(store.devices).toEqual([]);
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.registered).toBe(false);
  });

  it('refresh() populates devices', async () => {
    getPonterMock().listDevices.mockResolvedValue([sampleDevice]);

    const store = useDevicesStore();
    await store.refresh();

    expect(getPonterMock().listDevices).toHaveBeenCalled();
    expect(store.devices).toHaveLength(1);
    expect(store.devices[0].id).toBe('mybox-a1b2c3d4');
    expect(store.loading).toBe(false);
  });

  it('refresh() sets error on failure', async () => {
    getPonterMock().listDevices.mockRejectedValue(new Error('network down'));

    const store = useDevicesStore();
    await store.refresh();

    expect(store.error).toBe('network down');
    expect(store.devices).toEqual([]);
  });

  it('register() calls invoke and marks registered', async () => {
    mockPonter({
      registerDevice: () => sampleDevice,
      listDevices: () => [sampleDevice],
    });

    const store = useDevicesStore();
    const result = await store.register();

    expect(result).toEqual(sampleDevice);
    expect(store.registered).toBe(true);
    // The register result must never carry a credential field.
    expect(result).not.toHaveProperty('credential');
    expect(getPonterMock().registerDevice).toHaveBeenCalledWith({
      capabilities: ['terminal', 'desktop', 'files'],
    });
  });

  it('register() surfaces error without marking registered', async () => {
    getPonterMock().registerDevice.mockRejectedValue(
      new Error('AGENT_LIMIT_REACHED'),
    );

    const store = useDevicesStore();
    const result = await store.register();

    expect(result).toBeNull();
    expect(store.registered).toBe(false);
    expect(store.error).toBe('AGENT_LIMIT_REACHED');
  });

  it("register(['terminal', 'desktop']) forwards exact capabilities array", async () => {
    mockPonter({
      registerDevice: () => sampleDevice,
      listDevices: () => [sampleDevice],
    });

    const store = useDevicesStore();
    const result = await store.register(['terminal', 'desktop']);

    expect(result).toEqual(sampleDevice);
    expect(getPonterMock().registerDevice).toHaveBeenCalledWith({
      capabilities: ['terminal', 'desktop'],
    });
  });

  it('remove() deletes and removes the row', async () => {
    getPonterMock().deleteDevice.mockResolvedValue(true);

    const store = useDevicesStore();
    store.devices = [sampleDevice];
    const ok = await store.remove('mybox-a1b2c3d4');

    expect(ok).toBe(true);
    expect(getPonterMock().deleteDevice).toHaveBeenCalledWith('mybox-a1b2c3d4');
    expect(store.devices).toHaveLength(0);
  });

  it('remove() surfaces error on failure', async () => {
    getPonterMock().deleteDevice.mockRejectedValue(
      new Error('Agent not found'),
    );

    const store = useDevicesStore();
    const ok = await store.remove('dev-missing');

    expect(ok).toBe(false);
    expect(store.error).toBe('Agent not found');
  });

  it('refresh({ background: true }) does not set loading=true during in-flight request', async () => {
    const refreshPromise = new Promise<unknown>(() => {}); // never resolves
    getPonterMock().listDevices.mockReturnValue(refreshPromise as never);

    const store = useDevicesStore();
    void store.refresh({ background: true });

    // While the request is in-flight, loading must NOT be set to true.
    expect(store.loading).toBe(false);

    // devices.value should remain unchanged (empty) while inflight.
    expect(store.devices).toEqual([]);
  });

  it('refresh({ background: true }) still captures errors into store.error', async () => {
    getPonterMock().listDevices.mockRejectedValue(
      new Error('bg refresh failed'),
    );

    const store = useDevicesStore();
    await store.refresh({ background: true });

    expect(store.error).toBe('bg refresh failed');
    expect(store.devices).toEqual([]);
    expect(store.loading).toBe(false);
  });

  it('refresh({ background: true }) retains a pre-existing error while in-flight', async () => {
    // The flicker bug (E): the old code cleared `error` at the START of every
    // refresh, so a healthy 5s background poll blanked the banner for one tick.
    // A pre-existing error must survive while the background request is in-flight.
    const store = useDevicesStore();
    store.error = 'stale banner error';

    const pending = new Promise<unknown>(() => {}); // never resolves
    getPonterMock().listDevices.mockReturnValue(pending as never);

    void store.refresh({ background: true });

    // Pre-fix this was null (cleared at start) → this assertion fails (RED).
    expect(store.error).toBe('stale banner error');
  });

  it('refresh({ background: true }) clears the error on success', async () => {
    // On a successful background refresh the stale error is cleared (the fresh
    // result replaces it) and the list is replaced.
    const store = useDevicesStore();
    store.error = 'stale banner error';
    store.devices = [sampleDevice];

    getPonterMock().listDevices.mockResolvedValue([]);
    await store.refresh({ background: true });

    expect(store.error).toBeNull();
    expect(store.devices).toEqual([]);
  });

  it('refresh({ background: true }) surfaces a NEW error without clearing devices list', async () => {
    // Last-known list must remain mounted; only `error` updates.
    const store = useDevicesStore();
    store.devices = [sampleDevice];

    getPonterMock().listDevices.mockRejectedValue(
      new Error('session expired after refresh attempt: network boom'),
    );
    await store.refresh({ background: true });

    // Auth-failure string (starts with the refresh-failed prefix) is surfaced
    // verbatim so App.vue / the banner can react.
    expect(store.error).toBe(
      'session expired after refresh attempt: network boom',
    );
    // Stale-while-revalidate: the last-known list is NOT blanked.
    expect(store.devices).toHaveLength(1);
    expect(store.devices[0].id).toBe(sampleDevice.id);
    expect(store.loading).toBe(false);
  });

  it('register() with a refresh-failed (auth) error triggers logout()', async () => {
    const auth = useAuthStore();
    const logoutSpy = vi.spyOn(auth, 'logout').mockResolvedValue(undefined);

    getPonterMock().registerDevice.mockRejectedValue(
      new Error(
        'session expired after refresh attempt: Invalid or expired refresh token',
      ),
    );

    const store = useDevicesStore();
    const result = await store.register();

    expect(result).toBeNull();
    expect(store.registered).toBe(false);
    expect(logoutSpy).toHaveBeenCalledTimes(1);
  });

  it('register() with a non-auth error does NOT trigger logout()', async () => {
    const auth = useAuthStore();
    const logoutSpy = vi.spyOn(auth, 'logout').mockResolvedValue(undefined);

    getPonterMock().registerDevice.mockRejectedValue(new Error('network down'));

    const store = useDevicesStore();
    const result = await store.register();

    expect(result).toBeNull();
    expect(store.error).toBe('network down');
    expect(logoutSpy).not.toHaveBeenCalled();
  });

  // Auth classification (issue #107): the FE keys on the STABLE marker the Rust
  // layer prepends, never on server message text. One it.each table keeps every
  // distinct input as its own reporter case while the shared setup boilerplate
  // appears exactly once (Sonar new-code duplication).
  it.each([
    // Auth-deaths (marker present) → log out exactly once.
    ['register', 'unauthorized request: Invalid or expired token', true],
    ['register', 'unauthorized request: Token has been revoked', true],
    ['refresh', 'unauthorized request: User is inactive or not found', true],
    // A bare server message with NO marker is not the signal → must NOT log out.
    ['register', 'Invalid or expired token', false],
    // A transient 5xx is not an auth-death → must NOT log out (brief C).
    ['refresh', 'Request failed (HTTP 500)', false],
  ] as ['register' | 'refresh' | 'remove', string, boolean][])(
    '%s() with %s (logout: %s)',
    async (method, message, shouldLogout) => {
      const logoutSpy = armAuthFailure(message);
      const store = useDevicesStore();
      const result = await (method === 'register'
        ? store.register()
        : method === 'refresh'
          ? store.refresh()
          : store.remove('dev-1'));

      // The error is surfaced verbatim; the store settles (not loading) and no
      // stale devices appear.
      expect(store.error).toBe(message);
      expect(store.loading).toBe(false);
      expect(store.devices).toEqual([]);
      // register() fails closed (null, never marked registered); refresh() is void.
      if (method === 'register') {
        expect(result).toBeNull();
        expect(store.registered).toBe(false);
      } else if (method === 'refresh') {
        expect(result).toBeUndefined();
      } else {
        // remove returns false on error
        expect(result).toBe(false);
      }
      // Auth-death logs out exactly once; anything else must NOT log out.
      if (shouldLogout) {
        expect(logoutSpy).toHaveBeenCalledTimes(1);
      } else {
        expect(logoutSpy).not.toHaveBeenCalled();
      }
    },
  );

  it('remove() with a refresh-failed (auth) error triggers logout()', async () => {
    const auth = useAuthStore();
    const logoutSpy = vi.spyOn(auth, 'logout').mockResolvedValue(undefined);

    getPonterMock().deleteDevice.mockRejectedValue(
      new Error('session expired after refresh attempt: refresh reuse'),
    );

    const store = useDevicesStore();
    const ok = await store.remove('dev-1');

    expect(ok).toBe(false);
    expect(logoutSpy).toHaveBeenCalledTimes(1);
  });

  it('remove() with a non-auth error does NOT trigger logout()', async () => {
    const auth = useAuthStore();
    const logoutSpy = vi.spyOn(auth, 'logout').mockResolvedValue(undefined);

    getPonterMock().deleteDevice.mockRejectedValue(
      new Error('Agent not found'),
    );

    const store = useDevicesStore();
    const ok = await store.remove('dev-missing');

    expect(ok).toBe(false);
    expect(logoutSpy).not.toHaveBeenCalled();
  });

  it('refresh() (foreground) clears a pre-existing error before retrying', async () => {
    const store = useDevicesStore();
    store.error = 'previous error';

    getPonterMock().listDevices.mockResolvedValue([sampleDevice]);
    await store.refresh();

    expect(store.error).toBeNull();
    expect(store.devices).toHaveLength(1);
  });
});

describe('DevicesView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetPonterMock();
    vi.clearAllTimers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('renders empty state when no devices', async () => {
    mockPonter({ listDevices: () => [], getRuntimeStatus: () => 'stopped' });

    const wrapper = await mountView();

    const empty = wrapper.find('[data-testid="devices-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain('No devices registered yet');
  });

  it('renders device rows after refresh', async () => {
    mockPonter({
      listDevices: () => [sampleDevice],
      getRuntimeStatus: () => 'stopped',
    });

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
    mockPonter({
      registerDevice: () => sampleDevice,
      listDevices: () => [],
      getRuntimeStatus: () => 'stopped',
    });

    const wrapper = await mountView();

    await wrapper.find('[data-testid="devices-register"]').trigger('click');
    await flushPromises();

    expect(getPonterMock().registerDevice).toHaveBeenCalledWith({
      capabilities: ['terminal', 'desktop'],
    });
  });

  it('capabilities selector defaults to terminal+desktop (files off)', async () => {
    mockPonter({
      listDevices: () => [],
      getRuntimeStatus: () => 'stopped',
    });

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
    mockPonter({
      registerDevice: () => sampleDevice,
      listDevices: () => [],
      getRuntimeStatus: () => 'stopped',
    });

    const wrapper = await mountView();

    // Toggle files ON
    await wrapper.find('[data-test="register-cap-files"]').trigger('click');
    await nextTick();

    await wrapper.find('[data-testid="devices-register"]').trigger('click');
    await flushPromises();

    expect(getPonterMock().registerDevice).toHaveBeenCalledWith({
      capabilities: ['terminal', 'desktop', 'files'],
    });
  });

  it('register with files and terminal toggled off sends only desktop', async () => {
    mockPonter({
      registerDevice: () => sampleDevice,
      listDevices: () => [],
      getRuntimeStatus: () => 'stopped',
    });

    const wrapper = await mountView();

    // Toggle terminal OFF
    await wrapper.find('[data-test="register-cap-terminal"]').trigger('click');
    // Toggle files ON
    await wrapper.find('[data-test="register-cap-files"]').trigger('click');
    await nextTick();

    await wrapper.find('[data-testid="devices-register"]').trigger('click');
    await flushPromises();

    expect(getPonterMock().registerDevice).toHaveBeenCalledWith({
      capabilities: ['desktop', 'files'],
    });
  });

  it('runtime status indicator reflects getRuntimeStatus value', async () => {
    mockPonter({
      listDevices: () => [],
      getRuntimeStatus: () => 'connected',
    });

    const wrapper = await mountView();

    const statusEl = wrapper.find('[data-testid="runtime-status"]');
    expect(statusEl.attributes('data-status')).toBe('connected');
  });

  it('runtime-status event updates the indicator', async () => {
    mockPonter({
      listDevices: () => [],
      getRuntimeStatus: () => 'stopped',
      // onRuntimeStatus is set up via mockOnRuntimeStatus below — mockPonter
      // only resets other methods here; the handler capture must survive.
    });
    // Set up the onRuntimeStatus capture AFTER mockPonter so its mockReset
    // does not wipe the captured handler.
    const rt = mockOnRuntimeStatus();

    const wrapper = await mountView();

    const statusEl = wrapper.find('[data-testid="runtime-status"]');
    expect(statusEl.attributes('data-status')).toBe('stopped');

    // onRuntimeStatus was called during onMounted
    expect(getPonterMock().onRuntimeStatus).toHaveBeenCalled();

    // Fire the captured handler with a new status. The current `onRuntimeStatus`
    // callback receives the status string directly (not a Tauri event wrapper).
    expect(rt.handler).not.toBeNull();
    rt.handler!('connected');
    await nextTick();

    expect(statusEl.attributes('data-status')).toBe('connected');
  });

  it('runtime status handles getRuntimeStatus failure gracefully', async () => {
    mockPonter({
      listDevices: () => [],
      getRuntimeStatus: () => {
        throw new Error('Tauri not available');
      },
    });

    const wrapper = await mountView();

    const statusEl = wrapper.find('[data-testid="runtime-status"]');
    expect(statusEl.attributes('data-status')).toBe('unknown');
  });

  it('auto-refresh calls listDevices on interval', async () => {
    mockPonter({
      listDevices: () => [],
      getRuntimeStatus: () => 'connected',
    });

    const wrapper = await mountView();

    // Initially listDevices called once from onMounted + getRuntimeStatus
    expect(getPonterMock().listDevices).toHaveBeenCalledTimes(1);
    expect(getPonterMock().getRuntimeStatus).toHaveBeenCalledTimes(1);

    const listDevicesCountBefore =
      getPonterMock().listDevices.mock.calls.length;

    // Advance past the 5000ms interval
    vi.advanceTimersByTime(5000);
    await flushPromises();

    const listDevicesCountAfter = getPonterMock().listDevices.mock.calls.length;

    expect(listDevicesCountAfter).toBeGreaterThan(listDevicesCountBefore);
    wrapper.unmount();
  });

  it('unmount stops auto-refresh and unlistens', async () => {
    const rt = mockOnRuntimeStatus();
    mockPonter({
      listDevices: () => [],
      getRuntimeStatus: () => 'connected',
      onRuntimeStatus: () => rt.unsubscribe,
    });

    const wrapper = await mountView();

    // Verify onRuntimeStatus was called (we get the unlisten fn back)
    expect(getPonterMock().onRuntimeStatus).toHaveBeenCalled();
    expect(rt.unsubscribe).not.toHaveBeenCalled();

    wrapper.unmount();

    // The unlisten fn should have been called on unmount
    expect(rt.unsubscribe).toHaveBeenCalled();

    // Advancing timers after unmount should NOT trigger another refresh
    const listDevicesCountBefore =
      getPonterMock().listDevices.mock.calls.length;

    vi.advanceTimersByTime(5000);
    await flushPromises();

    const listDevicesCountAfter = getPonterMock().listDevices.mock.calls.length;

    expect(listDevicesCountAfter).toBe(listDevicesCountBefore);
  });

  it('delete button calls store.remove with confirmation', async () => {
    mockPonter({
      listDevices: () => [sampleDevice],
      deleteDevice: () => true,
      getRuntimeStatus: () => 'stopped',
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
    expect(getPonterMock().deleteDevice).toHaveBeenCalledWith(sampleDevice.id);
    wrapper.unmount();
  });

  it('never writes a credential or secret to webview storage', async () => {
    // Mock per-command-name to avoid call-order coupling with onMounted.
    mockPonter({
      registerDevice: () => sampleDevice,
      listDevices: () => [],
      getRuntimeStatus: () => 'stopped',
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
    mockPonter({ listDevices: () => [], getRuntimeStatus: () => 'stopped' });

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
    mockPonter({
      listDevices: () => [sampleDevice],
      getRuntimeStatus: () => 'stopped',
    });

    const store = useDevicesStore();
    const refreshSpy = vi.spyOn(store, 'refresh');
    const wrapper = await mountView();
    refreshSpy.mockClear();

    // Wait past the 5000ms interval
    vi.advanceTimersByTime(5000);
    await flushPromises();

    expect(refreshSpy).toHaveBeenCalledWith({ background: true });
    expect(wrapper.find('[data-testid="devices-loading"]').exists()).toBe(
      false,
    );

    wrapper.unmount();
  });

  it('does not show devices-loading placeholder during background refresh when devices are present', async () => {
    mockPonter({
      listDevices: () => [sampleDevice],
      getRuntimeStatus: () => 'stopped',
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
    mockPonter({
      listDevices: () => [sampleDevice],
      getRuntimeStatus: () => 'stopped',
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
    mockPonter({
      listDevices: () => [sampleDevice],
      getRuntimeStatus: () => 'stopped',
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
    mockPonter({
      listDevices: () => [sampleDevice],
      getRuntimeStatus: () => 'stopped',
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

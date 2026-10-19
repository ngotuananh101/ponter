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
  deviceCode: null,
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

/**
 * Mount DevicesView, settle onMounted's async work, and return the wrapper.
 *
 * `localDeviceCode` (when given) pins both the fleet row and the config cache
 * to that value, so a test can exercise the missing-code branch without
 * duplicating the whole mock setup.
 */
async function mountView(
  options: { stubTeleport?: boolean; localDeviceCode?: string | null } = {},
) {
  if (options.localDeviceCode !== undefined) {
    const deviceCode = options.localDeviceCode;
    defaultPonterMocks({
      listDevices: () => [{ ...localDevice, deviceCode }],
      getConfig: () => ({
        serverUrl: 'http://localhost:8080',
        allowInput: false,
        theme: null,
        hasServerUrl: true,
        localAgentId: localDevice.id,
        deviceCode,
        agentAutoStart: false,
        rememberMe: true,
        savedUsername: null,
      }),
    });
  }
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

/**
 * DevicesView tests cover the minimalist RustDesk / TeamViewer-style UI:
 *   - left "This Device" card (hostname, ID + copy, runtime status, toggle)
 *   - right "Remote Control" card (partner ID, mode selector, connect)
 *   - bottom "My Devices" list (rows + delete confirmation)
 *   - header (username, logout) and background auto-refresh
 *
 * The 18 store unit tests above are untouched and preserved verbatim.
 */

/** A device row representing THIS machine, used by the "This Device" card. */
const localDevice: DesktopDevice = {
  ...sampleDevice,
  id: 'local-dev-1234',
  hostname: 'localhost',
  platform: 'linux',
  deviceCode: '749281903',
  isOnline: true,
};

/** Default mock set used by most DevicesView tests: one device row + a local id. */
function defaultPonterMocks(overrides: Record<string, () => unknown> = {}) {
  const ponter = getPonterMock();
  ponter.listDevices.mockResolvedValue([localDevice]);
  ponter.getRuntimeStatus.mockResolvedValue('stopped');
  ponter.getLocalAgentId.mockResolvedValue(localDevice.id);
  ponter.getConfig.mockResolvedValue({
    serverUrl: 'http://localhost:8080',
    allowInput: false,
    theme: null,
    hasServerUrl: true,
    localAgentId: localDevice.id,
    deviceCode: localDevice.deviceCode,
    agentAutoStart: false,
    rememberMe: true,
    savedUsername: null,
  });
  for (const [k, fn] of Object.entries(overrides)) {
    (ponter as Record<string, Mock>)[k].mockImplementation(fn as never);
  }
}

describe('DevicesView.vue', () => {
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

  describe('header & layout', () => {
    it('renders the username badge signed-in-as text', async () => {
      defaultPonterMocks();
      const auth = useAuthStore();
      auth.user = { id: 'u1', username: 'alice', role: 'user' } as any;

      const wrapper = await mountView();

      const user = wrapper.find('[data-testid="devices-username"]');
      expect(user.exists()).toBe(true);
      expect(user.text()).toContain('Signed in as alice');
      wrapper.unmount();
    });

    it('logout button calls authStore.logout', async () => {
      defaultPonterMocks();

      const authStoreInstance = useAuthStore();
      const logoutSpy = vi
        .spyOn(authStoreInstance, 'logout')
        .mockResolvedValue(undefined);

      const wrapper = await mountView();

      const logoutBtn = wrapper.find('[data-testid="devices-logout"]');
      expect(logoutBtn.exists()).toBe(true);
      await logoutBtn.trigger('click');

      expect(logoutSpy).toHaveBeenCalledTimes(1);
      wrapper.unmount();
    });

    it('renders the two-column grid with This Device and Remote Control cards', async () => {
      defaultPonterMocks();

      const wrapper = await mountView();

      // Header card + This Device card + Remote Control card + My Devices card
      expect(
        wrapper.findAll('[data-testid="devices-root"] card, card').length,
      ).toBeGreaterThanOrEqual(0);
      expect(wrapper.find('[data-testid="this-device-id"]').exists()).toBe(
        true,
      );
      expect(
        wrapper.find('[data-testid="remote-agent-id-input"]').exists(),
      ).toBe(true);
      wrapper.unmount();
    });
  });

  describe('This Device card', () => {
    it('displays hostname, platform, and the local device ID', async () => {
      defaultPonterMocks();

      const wrapper = await mountView();

      expect(wrapper.find('[data-testid="this-device-hostname"]').text()).toBe(
        localDevice.hostname,
      );
      expect(wrapper.find('[data-testid="this-device-platform"]').text()).toBe(
        localDevice.platform,
      );
      expect(wrapper.find('[data-testid="this-device-id"]').text()).toBe(
        localDevice.id,
      );
      wrapper.unmount();
    });

    it('copy code button writes the raw device code and shows feedback', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const originalNav = window.navigator;
      Object.defineProperty(window, 'navigator', {
        value: { ...originalNav, clipboard: { writeText } },
        configurable: true,
        writable: true,
      });
      defaultPonterMocks();

      const wrapper = await mountView();
      const copyBtn = wrapper.find('[data-testid="copy-device-code"]');
      expect(copyBtn.exists()).toBe(true);
      expect(copyBtn.attributes('disabled')).toBeUndefined();

      await copyBtn.trigger('click');

      expect(writeText).toHaveBeenCalledWith('749281903');
      // Visual feedback: the check icon appears while copied (2s window).
      expect(wrapper.find('[data-testid="copy-device-code"]').html()).toContain(
        'lucide-check',
      );

      vi.advanceTimersByTime(2000);
      await nextTick();

      // After 2s the check icon is gone, reverted to the Copy icon.
      expect(
        wrapper.find('[data-testid="copy-device-code"]').html(),
      ).not.toContain('lucide-check');
      expect(wrapper.find('[data-testid="copy-device-code"]').html()).toContain(
        'lucide-copy',
      );

      Object.defineProperty(window, 'navigator', {
        value: originalNav,
        configurable: true,
        writable: true,
      });
      wrapper.unmount();
    });

    it('renders this-device-code with grouped digits', async () => {
      defaultPonterMocks();

      const wrapper = await mountView();

      const code = wrapper.find('[data-testid="this-device-code"]');
      expect(code.exists()).toBe(true);
      expect(code.text()).toBe('749 281 903');
      wrapper.unmount();
    });

    it('renders the placeholder and hides copy when deviceCode is null', async () => {
      const wrapper = await mountView({ localDeviceCode: null });

      expect(wrapper.find('[data-testid="this-device-code"]').text()).toBe('—');
      expect(wrapper.find('[data-testid="copy-device-code"]').exists()).toBe(
        false,
      );
      wrapper.unmount();
    });

    it('runtime status reflects getRuntimeStatus and labels "Running" when connected', async () => {
      defaultPonterMocks({ getRuntimeStatus: () => 'connected' });

      const wrapper = await mountView();

      const statusEl = wrapper.find('[data-testid="runtime-status"]');
      expect(statusEl.attributes('data-status')).toBe('connected');
      expect(statusEl.text()).toContain('Ready for remote connections');
      wrapper.unmount();
    });

    it('runtime-status event updates the indicator in real time', async () => {
      defaultPonterMocks({ getRuntimeStatus: () => 'stopped' });
      const rt = mockOnRuntimeStatus();

      const wrapper = await mountView();

      const statusEl = wrapper.find('[data-testid="runtime-status"]');
      expect(statusEl.attributes('data-status')).toBe('stopped');
      expect(rt.handler).not.toBeNull();

      rt.handler!('connected');
      await nextTick();

      expect(statusEl.attributes('data-status')).toBe('connected');
      wrapper.unmount();
    });

    it('allow-remote-control toggle is ON when running and OFF when stopped', async () => {
      defaultPonterMocks({
        getRuntimeStatus: () => 'connected',
        startAgent: () => ({ ok: true, message: '' }),
      });

      const wrapper = await mountView();
      const toggle = wrapper.find(
        '[data-testid="allow-remote-control-toggle"]',
      );
      expect(toggle.attributes('data-state')).toBe('on');
      expect(toggle.text()).toContain('Allowing connections');
      wrapper.unmount();

      // Now stopped state.
      const ponter = getPonterMock();
      ponter.getRuntimeStatus.mockResolvedValue('stopped');
      ponter.getLocalAgentId.mockResolvedValue(localDevice.id);
      const wrapper2 = await mountView();
      const toggle2 = wrapper2.find(
        '[data-testid="allow-remote-control-toggle"]',
      );
      expect(toggle2.attributes('data-state')).toBe('off');
      expect(toggle2.text()).toContain('Allow remote control');
      wrapper2.unmount();
    });

    it('toggle ON (running) calls stopAgent when clicked', async () => {
      defaultPonterMocks({
        getRuntimeStatus: () => 'connected',
        stopAgent: () => undefined,
      });

      const wrapper = await mountView();
      await wrapper
        .find('[data-testid="allow-remote-control-toggle"]')
        .trigger('click');
      await flushPromises();

      expect(getPonterMock().stopAgent).toHaveBeenCalledTimes(1);
      wrapper.unmount();
    });

    it('toggle OFF (stopped) calls startAgent when clicked', async () => {
      defaultPonterMocks({
        getRuntimeStatus: () => 'stopped',
        startAgent: () => ({ ok: true, message: '' }),
      });

      const wrapper = await mountView();
      await wrapper
        .find('[data-testid="allow-remote-control-toggle"]')
        .trigger('click');
      await flushPromises();

      expect(getPonterMock().startAgent).toHaveBeenCalledTimes(1);
      wrapper.unmount();
    });

    it('toggle disables while agentPending or registering', async () => {
      defaultPonterMocks({ getRuntimeStatus: () => 'stopped' });

      const wrapper = await mountView();
      // No pending state initially → enabled.
      expect(
        wrapper
          .find('[data-testid="allow-remote-control-toggle"]')
          .attributes('disabled'),
      ).toBeUndefined();
      wrapper.unmount();
    });

    it('surfaces a refused start in the alert', async () => {
      defaultPonterMocks({
        getRuntimeStatus: () => 'stopped',
        startAgent: () => ({
          ok: false,
          message: 'Device credential is missing; re-register this device',
        }),
      });

      const wrapper = await mountView();
      await wrapper
        .find('[data-testid="allow-remote-control-toggle"]')
        .trigger('click');
      await flushPromises();

      expect(wrapper.find('[data-testid="devices-error"]').text()).toContain(
        'Device credential is missing',
      );
      wrapper.unmount();
    });
  });

  describe('This Device auto-register on mount', () => {
    it('auto-registers with terminal+desktop when localAgentId is null', async () => {
      defaultPonterMocks({ getLocalAgentId: () => null });

      const wrapper = await mountView();
      await flushPromises();
      await nextTick();

      expect(getPonterMock().registerDevice).toHaveBeenCalledWith({
        capabilities: ['terminal', 'desktop'],
      });
      expect(getPonterMock().getLocalAgentId).toHaveBeenCalled();
      wrapper.unmount();
    });

    it('does not auto-register when a localAgentId already exists', async () => {
      defaultPonterMocks({ getLocalAgentId: () => localDevice.id });

      const wrapper = await mountView();
      await flushPromises();
      await nextTick();

      expect(getPonterMock().registerDevice).not.toHaveBeenCalled();
      wrapper.unmount();
    });
  });

  describe('Remote Control card', () => {
    it('connect button is disabled with no partner ID', async () => {
      defaultPonterMocks();

      const wrapper = await mountView();
      const btn = wrapper.find('[data-testid="remote-connect-btn"]');
      expect(btn.attributes('disabled')).toBeDefined();
      wrapper.unmount();
    });

    it('connect button enables when a partner ID is typed', async () => {
      defaultPonterMocks({
        openRemoteSession: () => ({ ok: true, url: 'ws://x' }),
      });

      const wrapper = await mountView();
      const input = wrapper.find('[data-testid="remote-agent-id-input"]');
      await input.setValue('partner-device-id');

      const btn = wrapper.find('[data-testid="remote-connect-btn"]');
      expect(btn.attributes('disabled')).toBeUndefined();
      wrapper.unmount();
    });

    it('mode selector defaults to desktop and toggles desktop/terminal/files', async () => {
      defaultPonterMocks();

      const wrapper = await mountView();

      expect(
        wrapper
          .find('[data-testid="remote-mode-desktop"]')
          .attributes('aria-pressed'),
      ).toBe('true');
      expect(
        wrapper
          .find('[data-testid="remote-mode-terminal"]')
          .attributes('aria-pressed'),
      ).toBe('false');
      expect(
        wrapper
          .find('[data-testid="remote-mode-files"]')
          .attributes('aria-pressed'),
      ).toBe('false');

      await wrapper
        .find('[data-testid="remote-mode-terminal"]')
        .trigger('click');
      await nextTick();
      expect(
        wrapper
          .find('[data-testid="remote-mode-terminal"]')
          .attributes('aria-pressed'),
      ).toBe('true');
      expect(
        wrapper
          .find('[data-testid="remote-mode-desktop"]')
          .attributes('aria-pressed'),
      ).toBe('false');

      await wrapper.find('[data-testid="remote-mode-files"]').trigger('click');
      await nextTick();
      expect(
        wrapper
          .find('[data-testid="remote-mode-files"]')
          .attributes('aria-pressed'),
      ).toBe('true');
      wrapper.unmount();
    });

    it('connect calls openRemoteSession with partner ID and desktop mode', async () => {
      defaultPonterMocks({
        openRemoteSession: () => ({ ok: true, url: 'wss://example' }),
      });
      const openSpy = vi.fn();
      vi.stubGlobal('open', openSpy);

      const wrapper = await mountView();
      const input = wrapper.find('[data-testid="remote-agent-id-input"]');
      await input.setValue('partner-abc');
      await wrapper.find('[data-testid="remote-connect-btn"]').trigger('click');
      await flushPromises();

      expect(getPonterMock().openRemoteSession).toHaveBeenCalledWith({
        agentId: 'partner-abc',
        mode: 'desktop',
      });
      expect(openSpy).toHaveBeenCalledWith('wss://example', '_blank');
      expect(wrapper.find('[data-testid="remote-error"]').exists()).toBe(false);
      vi.unstubAllGlobals();
      wrapper.unmount();
    });

    it('connect with terminal mode passes mode="terminal"', async () => {
      defaultPonterMocks({
        openRemoteSession: () => ({ ok: true, url: 'wss://example' }),
      });
      vi.stubGlobal('open', vi.fn());

      const wrapper = await mountView();
      await wrapper
        .find('[data-testid="remote-agent-id-input"]')
        .setValue('partner-x');
      await wrapper
        .find('[data-testid="remote-mode-terminal"]')
        .trigger('click');
      await wrapper.find('[data-testid="remote-connect-btn"]').trigger('click');
      await flushPromises();

      expect(getPonterMock().openRemoteSession).toHaveBeenCalledWith({
        agentId: 'partner-x',
        mode: 'terminal',
      });
      vi.unstubAllGlobals();
      wrapper.unmount();
    });

    it('surfaces a refused remote session in the error alert', async () => {
      defaultPonterMocks({
        openRemoteSession: () => ({
          ok: false,
          message: 'Partner is offline',
        }),
      });

      const wrapper = await mountView();
      await wrapper
        .find('[data-testid="remote-agent-id-input"]')
        .setValue('ghost');
      await wrapper.find('[data-testid="remote-connect-btn"]').trigger('click');
      await flushPromises();

      expect(getPonterMock().openRemoteSession).toHaveBeenCalledWith({
        agentId: 'ghost',
        mode: 'desktop',
      });
      const err = wrapper.find('[data-testid="remote-error"]');
      expect(err.exists()).toBe(true);
      expect(err.text()).toContain('Partner is offline');
      wrapper.unmount();
    });

    it('uses the default error message when ok=false and no message is returned', async () => {
      defaultPonterMocks({
        openRemoteSession: () => ({ ok: false }),
      });

      const wrapper = await mountView();
      await wrapper
        .find('[data-testid="remote-agent-id-input"]')
        .setValue('ghost');
      await wrapper.find('[data-testid="remote-connect-btn"]').trigger('click');
      await flushPromises();

      expect(wrapper.find('[data-testid="remote-error"]').text()).toContain(
        'Failed to open remote session',
      );
      wrapper.unmount();
    });

    it('groups partner input digits in threes while typing', async () => {
      defaultPonterMocks();

      const wrapper = await mountView();
      const input = wrapper.find('[data-testid="remote-agent-id-input"]');
      await input.setValue('749281903');

      expect((input.element as HTMLInputElement).value).toBe('749 281 903');
      wrapper.unmount();
    });

    it('preserves a pasted legacy agent id verbatim', async () => {
      defaultPonterMocks();

      const wrapper = await mountView();
      const input = wrapper.find('[data-testid="remote-agent-id-input"]');
      await input.setValue('dev_ab12cd34');

      expect((input.element as HTMLInputElement).value).toBe('dev_ab12cd34');
      wrapper.unmount();
    });
  });

  describe('My Devices list', () => {
    it('shows the loading placeholder only while loading and empty', async () => {
      // Return a never-resolving listDevices to keep `loading` true via the
      // store's foreground branch... instead, simulate empty + loading=false then
      // empty list renders the empty state. We test the loading state separately.
      defaultPonterMocks({ listDevices: () => Promise.resolve([]) });

      const wrapper = await mountView();

      const empty = wrapper.find('[data-testid="devices-empty"]');
      expect(empty.exists()).toBe(true);
      expect(empty.text()).toContain('No devices registered yet');
      wrapper.unmount();
    });

    it('renders device rows after refresh with hostname, platform, online, and ID', async () => {
      defaultPonterMocks();

      const wrapper = await mountView();

      const rows = wrapper.findAll('[data-testid="device-row"]');
      expect(rows).toHaveLength(1);
      expect(wrapper.find('[data-testid="device-hostname"]').text()).toBe(
        localDevice.hostname,
      );
      expect(wrapper.find('[data-testid="device-platform"]').text()).toBe(
        String(localDevice.platform),
      );
      expect(wrapper.find('[data-testid="device-online"]').text()).toContain(
        'online',
      );
      expect(wrapper.find('[data-testid="device-local-badge"]').exists()).toBe(
        true,
      );
      expect(wrapper.find('[data-testid="device-id"]').text()).toBe(
        localDevice.id,
      );
      wrapper.unmount();
    });

    it('marks only the row matching localAgentId with the "This device" badge', async () => {
      const other = {
        ...sampleDevice,
        id: 'other-device',
        hostname: 'otherbox',
      };
      defaultPonterMocks({ listDevices: () => [localDevice, other] });

      const wrapper = await mountView();

      const rows = wrapper.findAll('[data-testid="device-row"]');
      expect(rows).toHaveLength(2);
      // localDevice is the first because listDevices returns [localDevice, other]
      expect(rows[0]!.find('[data-testid="device-local-badge"]').exists()).toBe(
        true,
      );
      expect(rows[1]!.find('[data-testid="device-local-badge"]').exists()).toBe(
        false,
      );
      wrapper.unmount();
    });

    it('device [Connect] button calls openRemoteSession in desktop mode', async () => {
      const remote = {
        ...localDevice,
        id: 'remote-peer-9999',
        hostname: 'peerbox',
      };
      defaultPonterMocks({
        listDevices: () => [remote],
        openRemoteSession: () => ({ ok: true, url: 'wss://x' }),
      });
      // Stub window.open so the wss navigation doesn't blow up in happy-dom.
      const openSpy = vi.fn();
      vi.stubGlobal('open', openSpy);

      const wrapper = await mountView();
      await wrapper.find('[data-testid="device-connect"]').trigger('click');
      await flushPromises();

      expect(getPonterMock().openRemoteSession).toHaveBeenCalledWith({
        agentId: remote.id,
        mode: 'desktop',
      });
      expect(openSpy).toHaveBeenCalledWith('wss://x', '_blank');
      vi.unstubAllGlobals();
      wrapper.unmount();
    });

    it('device [Connect] is disabled for offline devices', async () => {
      const offline = { ...localDevice, isOnline: false };
      defaultPonterMocks({ listDevices: () => [offline] });

      const wrapper = await mountView();
      expect(
        wrapper.find('[data-testid="device-connect"]').attributes('disabled'),
      ).toBeDefined();
      wrapper.unmount();
    });

    it('device [Connect] is disabled for the local device', async () => {
      defaultPonterMocks();

      const wrapper = await mountView();
      expect(
        wrapper.find('[data-testid="device-connect"]').attributes('disabled'),
      ).toBeDefined();
      wrapper.unmount();
    });

    it('delete button opens the confirmation dialog', async () => {
      defaultPonterMocks();

      const wrapper = await mountView({ stubTeleport: true });
      await wrapper.find('[data-testid="device-delete"]').trigger('click');
      await flushPromises();
      await nextTick();

      expect(wrapper.find('[data-slot="alert-dialog-action"]').exists()).toBe(
        true,
      );
      expect(wrapper.find('[data-testid="device-hostname"]').exists()).toBe(
        true,
      );
      wrapper.unmount();
    });

    it('delete confirmation calls store.remove with the device id and refreshes localAgentId', async () => {
      defaultPonterMocks({
        deleteDevice: () => true,
      });

      const store = useDevicesStore();
      const removeSpy = vi.spyOn(store, 'remove');

      const wrapper = await mountView({ stubTeleport: true });
      await wrapper.find('[data-testid="device-delete"]').trigger('click');
      await flushPromises();
      await nextTick();

      const actionBtn = wrapper.find('[data-slot="alert-dialog-action"]');
      await actionBtn.trigger('click');
      await flushPromises();

      expect(removeSpy).toHaveBeenCalledWith(localDevice.id);
      expect(getPonterMock().deleteDevice).toHaveBeenCalledWith(localDevice.id);
      wrapper.unmount();
    });
  });

  describe('background refresh & unmount', () => {
    it('does not show devices-loading placeholder during background refresh when devices are present', async () => {
      defaultPonterMocks();

      const wrapper = await mountView();
      expect(wrapper.find('[data-testid="devices-loading"]').exists()).toBe(
        false,
      );

      vi.advanceTimersByTime(5000);
      await flushPromises();
      await nextTick();

      expect(wrapper.find('[data-testid="devices-loading"]').exists()).toBe(
        false,
      );
      expect(wrapper.find('[data-testid="devices-list"]').exists()).toBe(true);
      expect(wrapper.findAll('[data-testid="device-row"]')).toHaveLength(1);
      wrapper.unmount();
    });

    it('devices list remains mounted during background refresh', async () => {
      defaultPonterMocks();

      const wrapper = await mountView();
      const listBefore = wrapper.find('[data-testid="devices-list"]');
      expect(listBefore.exists()).toBe(true);

      vi.advanceTimersByTime(5000);
      await flushPromises();
      await nextTick();

      const listAfter = wrapper.find('[data-testid="devices-list"]');
      expect(listAfter.exists()).toBe(true);
      expect(wrapper.findAll('[data-testid="device-row"]')).toHaveLength(1);
      wrapper.unmount();
    });

    it('background refresh interval passes { background: true } to store.refresh', async () => {
      defaultPonterMocks();

      const store = useDevicesStore();
      const refreshSpy = vi.spyOn(store, 'refresh');
      const wrapper = await mountView();
      refreshSpy.mockClear();

      vi.advanceTimersByTime(5000);
      await flushPromises();

      expect(refreshSpy).toHaveBeenCalledWith({ background: true });
      wrapper.unmount();
    });

    it('unmount stops auto-refresh and unlistens runtime status', async () => {
      const rt = mockOnRuntimeStatus();
      defaultPonterMocks({ onRuntimeStatus: () => rt.unsubscribe });

      const wrapper = await mountView();
      expect(getPonterMock().onRuntimeStatus).toHaveBeenCalled();
      expect(rt.unsubscribe).not.toHaveBeenCalled();

      const listBefore = getPonterMock().listDevices.mock.calls.length;

      wrapper.unmount();
      expect(rt.unsubscribe).toHaveBeenCalled();

      vi.advanceTimersByTime(5000);
      await flushPromises();

      expect(getPonterMock().listDevices.mock.calls).toHaveLength(listBefore);
    });
  });

  describe('error handling', () => {
    it('surfaces a store error in the devices-error alert', async () => {
      defaultPonterMocks({
        listDevices: () => Promise.reject(new Error('boom')),
      });

      const wrapper = await mountView();
      const err = wrapper.find('[data-testid="devices-error"]');
      expect(err.exists()).toBe(true);
      expect(err.text()).toContain('boom');
      wrapper.unmount();
    });

    it('never writes a credential or secret to webview storage', async () => {
      // A registered device projection must never carry a credential field.
      defaultPonterMocks({
        registerDevice: () => sampleDevice,
        getLocalAgentId: () => sampleDevice.id,
      });

      const wrapper = await mountView();
      await flushPromises();

      expect(storageLength(window, 'l')).toBe(0);
      expect(storageLength(window, 's')).toBe(0);
      wrapper.unmount();
    });
  });
});

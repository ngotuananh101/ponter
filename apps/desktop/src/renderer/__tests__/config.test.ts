// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { resetPonterMock, getPonterMock } from './setup';
import { useConfigStore } from '@/stores/config';
import { initDesktopTheme } from '@/composables/useTheme';

describe('config store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetPonterMock();
  });

  it('hasServerUrl is false before load and true when the backend reports a server', async () => {
    const store = useConfigStore();
    const ponter = getPonterMock();
    expect(store.hasServerUrl).toBe(false);

    ponter.getConfig.mockResolvedValue({
      serverUrl: 'http://s:1',
      allowInput: true,
      theme: 'dark',
      hasServerUrl: true,
    });
    await store.load();
    expect(store.hasServerUrl).toBe(true);
    expect(store.serverUrl).toBe('http://s:1');
    expect(store.allowInput).toBe(true);
    expect(store.theme).toBe('dark');
    expect(ponter.getConfig).toHaveBeenCalledOnce();
  });

  it('load() resolves and flips configLoaded when getConfig fails', async () => {
    // Fail-soft (D): a rejected read must not surface as a rejection to the
    // caller (App.vue / main.ts) — pre-fix this test is RED because load()
    // re-threw. configLoaded must still flip so the startup gate never stalls.
    const store = useConfigStore();
    const ponter = getPonterMock();
    ponter.getConfig.mockRejectedValue(new Error('config read failed'));

    await expect(store.load()).resolves.toBeUndefined();
    expect(store.configLoaded).toBe(true);
    expect(store.hasServerUrl).toBe(false);
  });

  it('setServerUrl persists via saveConfig and clears editing', async () => {
    const store = useConfigStore();
    const ponter = getPonterMock();
    store.editing = true;
    ponter.saveConfig.mockResolvedValue(undefined);

    await store.setServerUrl('http://new:1');
    // Issue #150: only the changed field is sent, so a save can never clobber
    // the other persisted preferences.
    expect(ponter.saveConfig).toHaveBeenCalledWith({
      serverUrl: 'http://new:1',
    });
    expect(store.serverUrl).toBe('http://new:1');
    expect(store.hasServerUrl).toBe(true);
    expect(store.editing).toBe(false);
  });

  it('setTheme persists the theme without touching the server URL (Issue #150)', async () => {
    const store = useConfigStore();
    const ponter = getPonterMock();
    ponter.saveConfig.mockResolvedValue(undefined);

    await store.setTheme('dark');
    // Issue #150: the payload must NOT carry `serverUrl` at all. `undefined`
    // means "unchanged" to ConfigManager.save(); the previous `serverUrl: null`
    // meant "clear", so saving a theme wiped the persisted URL and sent the app
    // back to Server Setup on the next launch.
    expect(ponter.saveConfig).toHaveBeenCalledWith({ theme: 'dark' });
    expect(ponter.saveConfig.mock.calls[0]![0]).not.toHaveProperty('serverUrl');
    expect(store.theme).toBe('dark');
  });

  it('setAllowInput persists the gate without touching the server URL (Issue #150)', async () => {
    const store = useConfigStore();
    const ponter = getPonterMock();
    ponter.saveConfig.mockResolvedValue(undefined);

    await store.setAllowInput(true);
    expect(ponter.saveConfig).toHaveBeenCalledWith({ allowInput: true });
    expect(ponter.saveConfig.mock.calls[0]![0]).not.toHaveProperty('serverUrl');
    expect(store.allowInput).toBe(true);
  });

  it('useTheme persistence adapter never sends a serverUrl key (Issue #150)', async () => {
    const ponter = getPonterMock();
    ponter.saveConfig.mockResolvedValue(undefined);

    initDesktopTheme(null);
    const { useTheme } = await import('@/composables/useTheme');
    useTheme().set('dark');

    await vi.waitFor(() => expect(ponter.saveConfig).toHaveBeenCalled());
    expect(ponter.saveConfig.mock.calls[0]![0]).toEqual({ theme: 'dark' });
    expect(ponter.saveConfig.mock.calls[0]![0]).not.toHaveProperty('serverUrl');
  });
});

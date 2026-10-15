// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { resetPonterMock, getPonterMock } from './setup';
import { useConfigStore } from '@/stores/config';

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
    expect(ponter.saveConfig).toHaveBeenCalledWith({
      serverUrl: 'http://new:1',
      allowInput: false,
      theme: null,
    });
    expect(store.serverUrl).toBe('http://new:1');
    expect(store.hasServerUrl).toBe(true);
    expect(store.editing).toBe(false);
  });

  it('setTheme persists the theme and leaves serverUrl untouched (null)', async () => {
    const store = useConfigStore();
    const ponter = getPonterMock();
    ponter.saveConfig.mockResolvedValue(undefined);

    await store.setTheme('dark');
    expect(ponter.saveConfig).toHaveBeenCalledWith({
      serverUrl: null,
      allowInput: false,
      theme: 'dark',
    });
    expect(store.theme).toBe('dark');
  });
});

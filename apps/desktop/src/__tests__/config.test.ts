import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@tauri-apps/api/core', () => {
  const fn = vi.fn();
  return { __esModule: true, invoke: fn, default: { invoke: fn } };
});

import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '@/stores/config';

describe('config store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
  });

  it('hasServerUrl is false before load and true when the backend reports a server', async () => {
    const store = useConfigStore();
    expect(store.hasServerUrl).toBe(false);

    vi.mocked(invoke).mockResolvedValue({
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
    expect(invoke).toHaveBeenCalledWith('get_config');
  });

  it('setServerUrl persists via save_config and clears editing', async () => {
    const store = useConfigStore();
    store.editing = true;
    vi.mocked(invoke).mockResolvedValue(undefined);

    await store.setServerUrl('http://new:1');
    expect(invoke).toHaveBeenCalledWith('save_config', {
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
    vi.mocked(invoke).mockResolvedValue(undefined);

    await store.setTheme('dark');
    expect(invoke).toHaveBeenCalledWith('save_config', {
      serverUrl: null,
      allowInput: false,
      theme: 'dark',
    });
    expect(store.theme).toBe('dark');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@tauri-apps/api/core', () => {
  const fn = vi.fn();
  return { __esModule: true, invoke: fn, default: { invoke: fn } };
});

import { invoke } from '@tauri-apps/api/core';
import { useTheme, resetTheme } from '@/composables/useTheme';
import { useConfigStore } from '@/stores/config';

function mockMatchMedia(dark: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: dark && q.includes('dark'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe('useTheme', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    document.documentElement.classList.remove('dark');
    resetTheme();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove('dark');
  });

  it('defaults to light when the OS prefers light', () => {
    mockMatchMedia(false);
    resetTheme();
    const { isDark } = useTheme();
    expect(isDark.value).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('follows the OS dark preference when no stored theme', () => {
    mockMatchMedia(true);
    resetTheme();
    const { isDark } = useTheme();
    expect(isDark.value).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggle() flips the theme, applies .dark, and persists via save_config', async () => {
    mockMatchMedia(false);
    resetTheme();
    const { isDark, toggle } = useTheme();
    const config = useConfigStore();

    toggle();
    expect(isDark.value).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('save_config', {
      serverUrl: null,
      allowInput: false,
      theme: 'dark',
    });
    expect(config.theme).toBe('dark');
  });

  it('a stored theme wins over the OS preference', () => {
    mockMatchMedia(true); // OS dark
    const config = useConfigStore();
    config.theme = 'light'; // stored light
    resetTheme();
    const { isDark } = useTheme();
    expect(isDark.value).toBe(false);
  });
});

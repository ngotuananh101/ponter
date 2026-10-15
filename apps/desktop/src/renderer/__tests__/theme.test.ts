// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { resetPonterMock, getPonterMock } from './setup';

import { useTheme, resetTheme, initDesktopTheme } from '@/composables/useTheme';
import { useConfigStore } from '@/stores/config';

/**
 * Mock matchMedia so the shared theme composable's `prefersDark()` is
 * deterministic. `dark` parameter controls the (prefers-color-scheme: dark)
 * media query result.
 */
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
    resetPonterMock();
    document.documentElement.classList.remove('dark');
    initDesktopTheme(); // wires saveConfig({ theme }) as the persistence adapter
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

  it('toggle() flips the theme, applies .dark, and persists via saveConfig', async () => {
    mockMatchMedia(false);
    resetTheme();
    const { isDark, toggle } = useTheme();

    const ponter = getPonterMock();
    ponter.saveConfig.mockResolvedValue(undefined);
    toggle();
    expect(isDark.value).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    await Promise.resolve();
    expect(ponter.saveConfig).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('a stored theme wins over the OS preference', () => {
    mockMatchMedia(true); // OS dark
    const config = useConfigStore();
    config.theme = 'light'; // stored light
    // Re-seed the desktop persistence adapter so `get()` reads from config
    // store — mirroring how App.vue calls initDesktopTheme(config.theme).
    initDesktopTheme(config.theme);
    resetTheme();
    const { isDark } = useTheme();
    expect(isDark.value).toBe(false);
  });
});

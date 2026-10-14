import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  configureThemeStorage,
  resetTheme,
  useTheme,
  type Theme,
  type ThemeStorage,
} from './useTheme';

/** In-memory adapter — mirrors what an app supplies. */
function memoryStorage(initial: Theme | null = null): ThemeStorage {
  let value = initial;
  return {
    get: () => value,
    set: (t: Theme) => {
      value = t;
    },
  };
}

describe('useTheme (shared core)', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    configureThemeStorage(memoryStorage(null));
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('dark'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  });

  it('falls back to prefers-color-scheme when storage is empty', () => {
    resetTheme();
    expect(useTheme().theme.value).toBe('dark');
  });

  it('a stored value wins over prefers-color-scheme', () => {
    configureThemeStorage(memoryStorage('light'));
    resetTheme();
    expect(useTheme().theme.value).toBe('light');
  });

  it('set() persists through the configured adapter and updates the ref', () => {
    const storage = memoryStorage(null);
    configureThemeStorage(storage);
    useTheme().set('dark');
    expect(useTheme().theme.value).toBe('dark');
    expect(storage.get()).toBe('dark');
  });

  it('toggle() flips the theme and applies the class on <html>', () => {
    configureThemeStorage(memoryStorage('light'));
    resetTheme();
    useTheme().toggle();
    expect(useTheme().theme.value).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    useTheme().toggle();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('does not throw when the adapter set() throws', () => {
    configureThemeStorage({
      get: () => null,
      set: () => {
        throw new Error('storage unavailable');
      },
    });
    // The core must guard storage writes; a throwing adapter is a realistic
    // failure (private mode, quota). If the core does not guard, this throws.
    expect(() => useTheme().toggle()).not.toThrow();
  });
});

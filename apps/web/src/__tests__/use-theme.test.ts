import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTheme, resetTheme } from '@/composables/useTheme';

describe('useTheme composable', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    resetTheme();
  });

  it('12. Initial theme respects prefers-color-scheme when storage is empty', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('dark'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    resetTheme();
    const { theme } = useTheme();
    expect(theme.value).toBe('dark');
  });

  it('13. toggle() flips the class on <html> and persists to localStorage', () => {
    const { theme, toggle } = useTheme();
    theme.value = 'light';
    toggle();
    expect(theme.value).toBe('dark');
    expect(localStorage.getItem('remote.theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    toggle();
    expect(theme.value).toBe('light');
    expect(localStorage.getItem('remote.theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('14. A stored dark preference wins over matchMedia light', () => {
    localStorage.setItem('remote.theme', 'dark');
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false, // light
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    resetTheme();
    const { theme } = useTheme();
    expect(theme.value).toBe('dark');
  });

  it('15. When localStorage.setItem throws, toggle() still applies class without crashing', () => {
    const { toggle } = useTheme();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded / Private browsing');
    });

    expect(() => toggle()).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

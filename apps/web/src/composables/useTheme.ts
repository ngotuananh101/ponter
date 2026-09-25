import { ref, computed, watchEffect, type Ref, type ComputedRef } from 'vue';

export type Theme = 'light' | 'dark';

export interface UseTheme {
  theme: Ref<Theme>;
  isDark: ComputedRef<boolean>;
  toggle(): void;
  set(theme: Theme): void;
}

const STORAGE_KEY = 'remote.theme';

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch {
    // Ignore localStorage failures
  }

  if (
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark';
  }
  return 'light';
}

// Module-level singleton state
const theme = ref<Theme>(getInitialTheme());
const isDark = computed(() => theme.value === 'dark');

// Apply class to <html> element
if (typeof document !== 'undefined') {
  watchEffect(
    () => {
      const el = document.documentElement;
      if (theme.value === 'dark') {
        el.classList.add('dark');
      } else {
        el.classList.remove('dark');
      }
    },
    { flush: 'sync' },
  );
}

function setTheme(newTheme: Theme): void {
  theme.value = newTheme;
  try {
    localStorage.setItem(STORAGE_KEY, newTheme);
  } catch {
    // Ignore storage failure (e.g. private mode)
  }
}

function toggleTheme(): void {
  setTheme(theme.value === 'dark' ? 'light' : 'dark');
}

export function useTheme(): UseTheme {
  return {
    theme,
    isDark,
    toggle: toggleTheme,
    set: setTheme,
  };
}

/** Reset theme state for tests.
 * Only resets the in-memory theme ref; the caller (beforeEach) is responsible
 * for clearing localStorage. This allows tests to set a stored preference and
 * then call resetTheme() to re-read it via getInitialTheme().
 */
export function resetTheme(): void {
  theme.value = getInitialTheme();
}

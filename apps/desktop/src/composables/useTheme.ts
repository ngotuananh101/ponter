/**
 * Desktop theme composable (ADR-68).
 *
 * Mirrors the web behaviour (matchMedia + `.dark` class on <html>) but persists
 * through the Rust config file via the config store — NEVER webview storage
 * (R8: no browser storage APIs in production frontend code).
 */
import { ref, computed, watchEffect, type Ref, type ComputedRef } from 'vue';
import { useConfigStore, type ThemeName } from '@/stores/config';

export interface UseTheme {
  theme: Ref<ThemeName>;
  isDark: ComputedRef<boolean>;
  toggle(): void;
  set(theme: ThemeName): void;
}

function osPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** Resolve the initial theme: stored config wins, else the OS preference. */
function getInitialTheme(): ThemeName {
  try {
    const stored = useConfigStore().theme;
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Pinia not active yet (module import before app mount) — fall through.
  }
  return osPrefersDark() ? 'dark' : 'light';
}

const theme = ref<ThemeName>(getInitialTheme());
const isDark = computed(() => theme.value === 'dark');

if (typeof document !== 'undefined') {
  watchEffect(
    () => {
      const el = document.documentElement;
      if (theme.value === 'dark') el.classList.add('dark');
      else el.classList.remove('dark');
    },
    { flush: 'sync' },
  );
}

/** Apply the theme class as early as possible (called from main.ts before mount). */
export function applyInitialTheme(): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (theme.value === 'dark') el.classList.add('dark');
  else el.classList.remove('dark');
}

function setTheme(next: ThemeName): void {
  theme.value = next;
  try {
    // Fire-and-forget persist; a failed write must not break the toggle.
    void useConfigStore().setTheme(next);
  } catch {
    // Pinia not active — the class still applied.
  }
}

function toggleTheme(): void {
  setTheme(theme.value === 'dark' ? 'light' : 'dark');
}

export function useTheme(): UseTheme {
  return { theme, isDark, toggle: toggleTheme, set: setTheme };
}

/** Reset theme state for tests (re-reads the stored config / OS preference). */
export function resetTheme(): void {
  theme.value = getInitialTheme();
}

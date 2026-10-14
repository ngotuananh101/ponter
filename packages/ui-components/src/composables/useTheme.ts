/**
 * Shared theme state for Ponter apps.
 *
 * The composable owns the light/dark state, computes `isDark`, and applies the
 * `.dark` class on <html>. Persistence is injected: an app calls
 * `configureThemeStorage` once at startup with an adapter (web: localStorage;
 * Electron renderer: IPC to the main process). Until then a no-op adapter is
 * used, so `useTheme` is always safe to call.
 */
import { ref, computed, watchEffect, type Ref, type ComputedRef } from 'vue';

export type Theme = 'light' | 'dark';

export interface ThemeStorage {
  /** The persisted theme, or null when none is stored. */
  get(): Theme | null;
  /** Persist the theme. May throw (private mode, quota); the core guards it. */
  set(theme: Theme): void;
}

export interface UseTheme {
  theme: Ref<Theme>;
  isDark: ComputedRef<boolean>;
  toggle(): void;
  set(theme: Theme): void;
}

const noopStorage: ThemeStorage = {
  get: () => null,
  set: () => {},
};

let storage: ThemeStorage = noopStorage;

function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  );
}

function safeGet(): Theme | null {
  try {
    return storage.get();
  } catch {
    return null;
  }
}

function safeSet(theme: Theme): void {
  try {
    storage.set(theme);
  } catch {
    // A failing store must never break theming (private mode, quota).
  }
}

function getInitialTheme(): Theme {
  const stored = safeGet();
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersDark() ? 'dark' : 'light';
}

const theme = ref<Theme>(getInitialTheme());
const isDark = computed(() => theme.value === 'dark');

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

/**
 * Wire the app's persistence backend. Call once at app start. Re-reads the
 * initial theme so a stored value takes effect immediately.
 */
export function configureThemeStorage(next: ThemeStorage): void {
  storage = next;
  theme.value = getInitialTheme();
}

function setTheme(next: Theme): void {
  theme.value = next;
  safeSet(next);
}

function toggleTheme(): void {
  setTheme(theme.value === 'dark' ? 'light' : 'dark');
}

export function useTheme(): UseTheme {
  return { theme, isDark, toggle: toggleTheme, set: setTheme };
}

/**
 * Reset the in-memory theme to what storage/prefers-color-scheme currently
 * imply. Tests use this to re-read a changed storage/preference.
 */
export function resetTheme(): void {
  theme.value = getInitialTheme();
}

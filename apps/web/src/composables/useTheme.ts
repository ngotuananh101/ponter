/**
 * Web binding for the shared theme composable.
 *
 * Supplies the localStorage adapter and re-exports the shared API so existing
 * imports (`@/composables/useTheme`) keep working unchanged. Importing this
 * module configures the shared core's storage as a side effect, so a runtime
 * import is REQUIRED for web theme persistence (see main.ts).
 */
import {
  configureThemeStorage,
  resetTheme,
  useTheme,
  type Theme,
  type ThemeStorage,
  type UseTheme,
} from '@ponter/ui-components';

const STORAGE_KEY = 'remote.theme';

const localStorageThemeStorage: ThemeStorage = {
  get() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === 'light' || stored === 'dark' ? stored : null;
    } catch {
      return null;
    }
  },
  set(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignore storage failure (e.g. private mode / quota).
    }
  },
};

configureThemeStorage(localStorageThemeStorage);

export { useTheme, resetTheme };
export type { Theme, UseTheme };

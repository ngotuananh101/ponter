import {
  useTheme as useSharedTheme,
  configureThemeStorage,
  type Theme,
} from '@ponter/ui-components';

let cachedTheme: Theme | null = null;

export function initDesktopTheme(initialTheme?: Theme | null): void {
  cachedTheme = initialTheme || null;

  configureThemeStorage({
    get: () => cachedTheme,
    set: (theme: Theme) => {
      cachedTheme = theme;
      if (typeof window !== 'undefined' && window.ponter?.saveConfig) {
        window.ponter.saveConfig({ theme }).catch(() => {
          /* best-effort: persistence can fail in private/quota */
        });
      }
    },
  });
}

export function useTheme() {
  return useSharedTheme();
}

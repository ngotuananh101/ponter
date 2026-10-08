import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './style.css';
import { applyInitialTheme } from './composables/useTheme';

// Apply the OS/stored theme before mount to minimise first-paint flash (ADR-68).
applyInitialTheme();

const app = createApp(App).use(createPinia());
app.mount('#app');

// Reconcile the persisted theme once the store can read config (ADR-68).
// A single async task with every promise awaited/handled: a failed config read
// must not break the app, so the error is swallowed and the initial theme kept.
void (async () => {
  try {
    const { useConfigStore } = await import('@/stores/config');
    const { useTheme } = await import('@/composables/useTheme');
    await useConfigStore().load();
    const stored = useConfigStore().theme;
    if (stored === 'light' || stored === 'dark') {
      useTheme().set(stored);
    }
  } catch {
    // Config could not be read — keep the OS/initial theme.
  }
})();

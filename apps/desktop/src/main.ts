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
import('@/stores/config').then(({ useConfigStore }) => {
  useConfigStore()
    .load()
    .then(() => {
      const stored = useConfigStore().theme;
      if (stored === 'light' || stored === 'dark') {
        import('@/composables/useTheme').then(({ useTheme }) =>
          useTheme().set(stored),
        );
      }
    })
    .catch(() => {});
});

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './style.css';
import { initDesktopTheme } from './composables/useTheme';

const app = createApp(App).use(createPinia());

// Apply the OS/stored theme before mount to minimise first-paint flash (ADR-68).
// Persisted theme reconciliation happens in App.vue onMounted after config load.
initDesktopTheme();

app.mount('#app');

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './style.css';
// Configures the shared theme composable with the localStorage adapter.
// Required: the only other importer is ThemeToggle, which moves to the shared
// package in the next task and will no longer pull in this web adapter.
import './composables/useTheme';
// vue-sonner ships its stylesheet separately and does not inject it at runtime
// for a Vite SPA (only the Nuxt module does). Without this the Toaster renders
// unstyled — no positioning, background, or rich-colors palette.
import 'vue-sonner/style.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');

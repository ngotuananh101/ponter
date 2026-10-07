import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './style.css';
// vue-sonner ships its stylesheet separately and does not inject it at runtime
// for a Vite SPA (only the Nuxt module does). Without this the Toaster renders
// unstyled — no positioning, background, or rich-colors palette.
import 'vue-sonner/style.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');

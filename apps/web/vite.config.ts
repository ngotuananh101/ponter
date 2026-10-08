import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@/components/ui': fileURLToPath(
        new URL(
          '../../packages/ui-components/src/components/ui',
          import.meta.url,
        ),
      ),
      '@/lib/utils': fileURLToPath(
        new URL('../../packages/ui-components/src/lib/utils', import.meta.url),
      ),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});

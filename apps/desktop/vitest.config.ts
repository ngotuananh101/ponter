import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // More specific aliases first (Vite uses the first match).
      '@/lib/utils': fileURLToPath(
        new URL('../../packages/ui-components/src/lib/utils', import.meta.url),
      ),
      '@/components/ui': fileURLToPath(
        new URL(
          '../../packages/ui-components/src/components/ui',
          import.meta.url,
        ),
      ),
      // Match tsconfig.web.json paths: `@/*` → `src/renderer/*`
      '@': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: [
      './src/main/__tests__/setup.ts',
      './src/renderer/__tests__/setup.ts',
    ],
  },
});

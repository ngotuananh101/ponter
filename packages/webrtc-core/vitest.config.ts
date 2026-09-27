import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The E2E harness needs a running Worker and a built Rust binary, so it
    // must not run in the default suite: `pnpm test` has neither, and a
    // failure here would be reported as a `webrtc-core` regression. It runs
    // under `vitest.e2e.config.ts` (Task 8's `e2e` job).
    exclude: [...configDefaults.exclude, 'test/e2e/**'],
  },
});

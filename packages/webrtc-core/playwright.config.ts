import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the cross-language browser smoke test (ADR-49).
 *
 * Runs exclusively against Chromium in headless mode. The spec manages server,
 * Vite, and agent processes internally to maintain the single-port (8787)
 * execution discipline shared with the Vitest E2E suite.
 */
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.pw.ts',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        launchOptions: {
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },
  ],
});

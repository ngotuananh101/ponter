import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The P0 spike drives a real Chromium peer over loopback: DTLS + ICE
    // plus a decode window. The default 5 s ceiling is far below the time
    // that exchange legitimately takes.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

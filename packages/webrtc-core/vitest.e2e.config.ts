import { defineConfig } from 'vitest/config';

/**
 * Layer 3 — the cross-language E2E suite.
 *
 * Deliberately a SEPARATE config rather than an `include` glob in the default
 * one: this suite spawns a Worker and a Rust binary, so it needs ~30 s of
 * setup the unit suite must not pay, and a failure here is a different
 * diagnosis than a failure there. `pnpm test` never runs it; Task 8's `e2e`
 * CI job does.
 *
 * `testTimeout` is generous because the harness waits on a real DTLS
 * handshake. Every individual wait inside the test is separately bounded, so
 * a hang fails with a specific message rather than this global number.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.e2e.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One file, one Worker, one agent. `fileParallelism` stops two files from
    // racing over port 8787 and the shared local D1 file; `sequence.concurrent`
    // is the separate knob that stops two tests within a file from doing the
    // same. Both are set because they are not the same option — with one file
    // today, only the second is load-bearing, and the first is here so adding
    // a second file later cannot silently reintroduce a port collision.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});

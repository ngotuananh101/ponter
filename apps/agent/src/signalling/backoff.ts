/**
 * The agent's reconnect ladder.
 *
 * Deliberately NOT `ReconnectBackoff` from this monorepo's `@ponter/webrtc-core`.
 * That class is the browser/HTTP ladder: `min(initial × 2^n, max) + ±jitter`,
 * where the jitter is anti-thundering-herd behaviour for many browser tabs. An
 * agent has one socket per host, the signalling server has been tested against
 * this exact ladder, and a shared class configured into a different shape on
 * one consumer would mean two things.
 *
 * Integer milliseconds and no jitter: `Duration` cannot hold 1012.5, and the
 * Rust rounds at each step.
 */
export const BACKOFF_INITIAL_MS = 200;
export const BACKOFF_MAX_MS = 2000;
export const BACKOFF_FACTOR = 1.5;

export function nextBackoff(currentMs: number): number {
  return Math.round(Math.min(currentMs * BACKOFF_FACTOR, BACKOFF_MAX_MS));
}

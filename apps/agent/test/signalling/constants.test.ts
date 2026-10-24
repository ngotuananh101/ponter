import { describe, expect, it } from 'vitest';
import {
  IDLE_TIMEOUT_MS,
  MAX_DATA_CHANNEL_FRAME_BYTES,
  MAX_INBOUND_FRAME_BYTES,
  PING_INTERVAL_MS,
} from '../../src/signalling/constants.js';

describe('keepalive constants', () => {
  it('pings every 30 s and tolerates exactly three missed pings', () => {
    // The two constants are one decision: the server treats a ping older than
    // 90 s as a dead socket, so the interval must be a third of the timeout.
    // Changing either alone fails here rather than in production.
    expect(PING_INTERVAL_MS).toBe(30_000);
    expect(IDLE_TIMEOUT_MS).toBe(90_000);
    expect(PING_INTERVAL_MS * 3).toBe(IDLE_TIMEOUT_MS);
  });
});

describe('frame caps', () => {
  it('caps a signalling frame at 256 KiB', () => {
    expect(MAX_INBOUND_FRAME_BYTES).toBe(256 * 1024);
  });

  it('caps a data-channel frame at 64 KiB', () => {
    expect(MAX_DATA_CHANNEL_FRAME_BYTES).toBe(64 * 1024);
  });
});

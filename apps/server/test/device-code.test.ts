import { describe, it, expect } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { closeDb, getDb } from '../src/db/client';
import {
  backfillDeviceCodes,
  generateDeviceCode,
  normalizeDeviceCode,
} from '../src/utils/device-code';

describe('generateDeviceCode', () => {
  it('emits exactly nine digits with a non-zero first digit', () => {
    for (let i = 0; i < 2_000; i += 1) {
      const code = generateDeviceCode();
      expect(code).toMatch(/^[1-9]\d{8}$/);
    }
  });

  it('stays inside the documented range', () => {
    for (let i = 0; i < 500; i += 1) {
      const value = Number(generateDeviceCode());
      expect(value).toBeGreaterThanOrEqual(100_000_000);
      expect(value).toBeLessThanOrEqual(999_999_999);
    }
  });

  it('distributes codes across the range and does not produce duplicate values', () => {
    const codes = new Set(Array.from({ length: 200 }, generateDeviceCode));
    expect(codes.size).toBeGreaterThan(190);
  });
});

describe('backfillDeviceCodes', () => {
  it('assigns a code to every row that has none and is idempotent', () => {
    closeDb();
    const freshDb = getDb(':memory:');
    const sqlite = (freshDb as unknown as { $client: BetterSqlite3.Database })
      .$client;
    // A row inserted without a code models a pre-migration agent.
    sqlite
      .prepare(
        `INSERT INTO users (id, username, public_key) VALUES ('u1', 'u1', 'pk')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO agents (id, user_id, public_key) VALUES ('dev_aaaaaaaa', 'u1', 'pk')`,
      )
      .run();

    expect(backfillDeviceCodes(sqlite)).toBe(1);
    const row = sqlite
      .prepare(`SELECT device_code FROM agents WHERE id = 'dev_aaaaaaaa'`)
      .get() as { device_code: string };
    expect(row.device_code).toMatch(/^[1-9]\d{8}$/);

    // Second run: nothing to do, and the existing code is untouched.
    expect(backfillDeviceCodes(sqlite)).toBe(0);
    const again = sqlite
      .prepare(`SELECT device_code FROM agents WHERE id = 'dev_aaaaaaaa'`)
      .get() as { device_code: string };
    expect(again.device_code).toBe(row.device_code);
    closeDb();
  });

  it('normalizeDeviceCode is exported from the server module', () => {
    expect(normalizeDeviceCode('749 281 903')).toBe('749281903');
  });
});

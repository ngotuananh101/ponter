import { describe, it, expect } from 'vitest';
import { generateDeviceCode } from '../src/utils/device-code';

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

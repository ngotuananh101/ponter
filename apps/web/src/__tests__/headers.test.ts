import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const headers = readFileSync(resolve(__dirname, '../../public/_headers'), 'utf8');

it('sets a strict CSP with no unsafe-inline and a frame-ancestors lockdown', () => {
  expect(headers).toContain('Content-Security-Policy:');
  expect(headers).toContain("default-src 'self'");
  expect(headers).toContain("frame-ancestors 'none'");
  expect(headers).not.toContain("'unsafe-eval'");
  expect(headers).toContain('Strict-Transport-Security');
  expect(headers).toContain('X-Content-Type-Options: nosniff');
});

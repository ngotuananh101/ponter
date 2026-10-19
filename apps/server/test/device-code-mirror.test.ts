import { describe, it, expect } from 'vitest';
import { normalizeDeviceCode as serverMirror } from '../src/utils/device-code';
import { normalizeDeviceCode as sharedSource } from '@ponter/shared';

// The server keeps a local copy of this pure function because @ponter/shared
// ships TypeScript source and the production image runs compiled JS — a runtime
// import would crash the server at boot (ERR_MODULE_NOT_FOUND). This test pins
// the mirror to the shared source: the desktop and web format one way while the
// server resolves another, a divergence would silently break device-code entry.
describe('normalizeDeviceCode (server mirror)', () => {
  const inputs = [
    '749281903',
    '749 281 903',
    '749-281-903',
    ' 749281903 ',
    '  749 - 281 - 903  ',
    'dev_ab12cd34',
    'dev-ab12-cd34',
    '',
    '   ',
    'abc',
    'a'.repeat(500),
  ];

  it('matches @ponter/shared byte-for-byte on representative inputs', () => {
    for (const input of inputs) {
      expect(serverMirror(input)).toBe(sharedSource(input));
    }
  });

  it('is byte-stable across calls', () => {
    expect(serverMirror('749 281 903')).toBe(serverMirror('749 281 903'));
  });

  it('collapses a spaced code to the canonical digits', () => {
    expect(serverMirror('749 281 903')).toBe('749281903');
  });

  it('preserves a legacy agent id', () => {
    expect(serverMirror('dev_ab12cd34')).toBe('dev_ab12cd34');
  });
});

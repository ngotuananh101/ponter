import { describe, it, expect } from 'vitest';
import { formatDeviceCode, normalizeDeviceCode } from '../src/device-code';

describe('formatDeviceCode', () => {
  it('groups nine digits as XXX XXX XXX', () => {
    expect(formatDeviceCode('749281903')).toBe('749 281 903');
  });

  it('renders the em dash placeholder for a missing code', () => {
    expect(formatDeviceCode(null)).toBe('—');
    expect(formatDeviceCode(undefined)).toBe('—');
    expect(formatDeviceCode('')).toBe('—');
  });

  it('does not re-group a value that is not exactly nine digits', () => {
    expect(formatDeviceCode('dev_ab12cd34')).toBe('dev_ab12cd34');
  });

  it('formats an already spaced code by normalising first', () => {
    expect(formatDeviceCode('749 281 903')).toBe('749 281 903');
  });
});

describe('normalizeDeviceCode', () => {
  it('strips spaces', () => {
    expect(normalizeDeviceCode('749 281 903')).toBe('749281903');
  });

  it('strips dashes', () => {
    expect(normalizeDeviceCode('749-281-903')).toBe('749281903');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeDeviceCode(' 749281903 ')).toBe('749281903');
  });

  it('leaves a legacy agent id untouched', () => {
    expect(normalizeDeviceCode('dev_ab12cd34')).toBe('dev_ab12cd34');
  });

  it('returns non-numeric text trimmed rather than emptied', () => {
    expect(normalizeDeviceCode('  abc def  ')).toBe('abcdef');
  });
});

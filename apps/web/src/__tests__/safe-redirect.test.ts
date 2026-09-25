import { describe, it, expect } from 'vitest';
import { safeRedirect } from '@/lib/safe-redirect';

describe('safeRedirect', () => {
  it('passes through a same-origin path', () => {
    expect(safeRedirect('/dashboard')).toBe('/dashboard');
  });

  it('preserves query and hash on a same-origin path', () => {
    expect(safeRedirect('/dashboard?tab=agents#top')).toBe(
      '/dashboard?tab=agents#top',
    );
  });

  it('rejects a protocol-relative URL', () => {
    expect(safeRedirect('//evil.example.com/x')).toBe('/dashboard');
  });

  it('rejects a backslash- escaped host', () => {
    expect(safeRedirect('/\\evil.example.com')).toBe('/dashboard');
  });

  it('rejects an absolute cross-origin URL', () => {
    expect(safeRedirect('https://evil.example.com/x')).toBe('/dashboard');
  });

  it('falls back for a non-string or empty value', () => {
    expect(safeRedirect(undefined)).toBe('/dashboard');
    expect(safeRedirect(['/dashboard'])).toBe('/dashboard');
    expect(safeRedirect('')).toBe('/dashboard');
  });
});

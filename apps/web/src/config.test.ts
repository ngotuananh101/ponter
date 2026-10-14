import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApiBaseUrl } from './config';

describe('getApiBaseUrl', () => {
  const originalConfig = window.__PONTER_CONFIG__;

  beforeEach(() => {
    delete window.__PONTER_CONFIG__;
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    window.__PONTER_CONFIG__ = originalConfig;
    vi.unstubAllEnvs();
  });

  it('prefers window.__PONTER_CONFIG__.apiUrl when present and non-empty', () => {
    window.__PONTER_CONFIG__ = { apiUrl: 'https://runtime.example.com' };
    vi.stubEnv('VITE_API_URL', 'https://build.example.com');

    expect(getApiBaseUrl()).toBe('https://runtime.example.com');
  });

  it('ignores empty or whitespace-only window.__PONTER_CONFIG__.apiUrl and falls back to VITE_API_URL', () => {
    window.__PONTER_CONFIG__ = { apiUrl: '   ' };
    vi.stubEnv('VITE_API_URL', 'https://build.example.com');

    expect(getApiBaseUrl()).toBe('https://build.example.com');
  });

  it('falls back to window.location.origin when neither runtime nor build URL is provided', () => {
    delete window.__PONTER_CONFIG__;
    vi.stubEnv('VITE_API_URL', '');

    expect(getApiBaseUrl()).toBe(window.location.origin);
  });

  it('trims leading and trailing whitespace from runtime and build URLs', () => {
    window.__PONTER_CONFIG__ = { apiUrl: '  https://trimmed.example.com  ' };
    expect(getApiBaseUrl()).toBe('https://trimmed.example.com');
  });
});

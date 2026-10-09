import { describe, it, expect } from 'vitest';
import { getAllowedOrigins } from '../src/utils/cors';
import { validateEnv } from '../src/utils/validate-env';
import { createApp } from '../src/app';

const JWT = 'a'.repeat(40);
const REFRESH = 'b'.repeat(40);

describe('getAllowedOrigins', () => {
  it('parses a comma-separated allowlist', () => {
    expect(
      getAllowedOrigins({ CORS_ORIGIN: 'https://a.test, https://b.test' }),
    ).toEqual(['https://a.test', 'https://b.test']);
  });

  it('returns * only when the variable is unset or explicitly *', () => {
    expect(getAllowedOrigins({})).toBe('*');
    expect(getAllowedOrigins({ CORS_ORIGIN: '*' })).toBe('*');
  });
});

describe('validateEnv — CORS in production', () => {
  it('throws when CORS_ORIGIN is unset in production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        JWT_SECRET: JWT,
        REFRESH_TOKEN_SECRET: REFRESH,
      }),
    ).toThrow(/CORS_ORIGIN/);
  });

  it('throws on a wildcard CORS_ORIGIN in production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        JWT_SECRET: JWT,
        REFRESH_TOKEN_SECRET: REFRESH,
        CORS_ORIGIN: '*',
      }),
    ).toThrow(/CORS_ORIGIN/);
  });

  it('allows an unset CORS_ORIGIN outside production (dev convenience)', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        JWT_SECRET: JWT,
        REFRESH_TOKEN_SECRET: REFRESH,
      }),
    ).not.toThrow();
  });

  it('allows an explicit allowlist in production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        JWT_SECRET: JWT,
        REFRESH_TOKEN_SECRET: REFRESH,
        CORS_ORIGIN: 'https://app.example.com',
      }),
    ).not.toThrow();
  });
});

describe('CORS preflight — agent update (PATCH)', () => {
  it('allows PATCH in Access-Control-Allow-Methods', async () => {
    const app = createApp();
    const res = await app.request('/api/agents/x', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.test',
        'Access-Control-Request-Method': 'PATCH',
      },
    });
    const allowed = res.headers.get('access-control-allow-methods') ?? '';
    expect(allowed).toContain('PATCH');
  });
});

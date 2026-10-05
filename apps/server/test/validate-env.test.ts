import { describe, it, expect } from 'vitest';
import { validateEnv, MIN_SECRET_LENGTH } from '../src/utils/validate-env';

const JWT = 'a'.repeat(40);
const REFRESH = 'b'.repeat(40);

describe('validateEnv', () => {
  it('accepts two distinct secrets at or above the minimum length', () => {
    expect(() =>
      validateEnv({
        JWT_SECRET: JWT,
        REFRESH_TOKEN_SECRET: REFRESH,
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://app.example.com',
      }),
    ).not.toThrow();
  });

  it('throws when JWT_SECRET is missing', () => {
    expect(() =>
      validateEnv({ REFRESH_TOKEN_SECRET: REFRESH }),
    ).toThrow(/JWT_SECRET/);
  });

  it('throws when a secret is shorter than the minimum', () => {
    expect(() =>
      validateEnv({
        JWT_SECRET: 'short',
        REFRESH_TOKEN_SECRET: REFRESH,
      }),
    ).toThrow(/at least/);
  });

  it('throws when the two secrets are identical', () => {
    expect(() =>
      validateEnv({ JWT_SECRET: JWT, REFRESH_TOKEN_SECRET: JWT }),
    ).toThrow(/must differ/);
  });

  it('exposes a minimum length of 32', () => {
    expect(MIN_SECRET_LENGTH).toBe(32);
  });
});

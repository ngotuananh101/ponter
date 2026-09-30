import { AppError } from '../middleware/error.js';

/**
 * Environment-backed secrets, extracted from `routes/auth.ts` so the
 * WebSocket ticket route can mint tokens with the same secret the REST
 * endpoints verify against.
 *
 * Both getters throw an `AppError` (500) rather than returning a fallback:
 * an unset secret is a deployment fault, and silently signing with an empty
 * string would produce tokens that verify against the same empty string —
 * a misconfiguration that looks like it works.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new AppError(
      'JWT_SECRET is not configured',
      500,
      'INTERNAL_SERVER_ERROR',
    );
  }
  return secret;
}

export function getRefreshSecret(): string {
  const secret = process.env.REFRESH_TOKEN_SECRET;
  if (!secret) {
    throw new AppError(
      'REFRESH_TOKEN_SECRET is not configured',
      500,
      'INTERNAL_SERVER_ERROR',
    );
  }
  return secret;
}

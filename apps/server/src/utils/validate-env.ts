/**
 * Fail-fast validation of the secrets the server cannot run without.
 *
 * `getJwtSecret()` already throws when `JWT_SECRET` is unset, but "first use"
 * is the first login request — in production, minutes after boot, with the
 * process reporting healthy. A misconfigured deploy must fail where an
 * operator is watching, so `startServer` calls this before it listens.
 *
 * Plain `Error`, not `AppError`: this runs at startup, where the only correct
 * outcome is a non-zero exit, not a JSON response.
 */

/** Minimum HMAC secret length. 32 chars ≈ 256 bits of ASCII entropy. */
export const MIN_SECRET_LENGTH = 32;

export interface EnvLike {
  NODE_ENV?: string;
  JWT_SECRET?: string;
  REFRESH_TOKEN_SECRET?: string;
  CORS_ORIGIN?: string;
}

export function validateEnv(env: EnvLike = process.env): void {
  requireSecret('JWT_SECRET', env.JWT_SECRET);
  requireSecret('REFRESH_TOKEN_SECRET', env.REFRESH_TOKEN_SECRET);

  // A shared secret would let an access token be replayed as a refresh token
  // and vice versa, silently defeating the type separation `verifyTokenForUser`
  // enforces. Two names, one value, is always a misconfiguration.
  if (env.JWT_SECRET === env.REFRESH_TOKEN_SECRET) {
    throw new Error(
      'JWT_SECRET and REFRESH_TOKEN_SECRET must differ; the same value for ' +
        'both defeats access/refresh token separation',
    );
  }

  // The Origin header is the CSWSH defence for the browser WebSocket upgrade
  // (`routes/ws.ts`). A wildcard turns that defence off, and an unset variable
  // used to mean the same thing silently. In production both are refused here,
  // at boot, so a deploy cannot ship with cross-site sockets open.
  if (env.NODE_ENV === 'production') {
    const cors = env.CORS_ORIGIN?.trim();
    if (!cors || cors === '*') {
      throw new Error(
        'CORS_ORIGIN must be an explicit allowlist in production; a wildcard ' +
          'or an unset value is refused',
      );
    }
  }
}

function requireSecret(name: string, value: string | undefined): void {
  if (!value) {
    throw new Error(
      `${name} is not set. Generate one with \`openssl rand -base64 48\`.`,
    );
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${name} must be at least ${MIN_SECRET_LENGTH} characters (got ${value.length}).`,
    );
  }
}

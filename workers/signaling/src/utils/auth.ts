import type { Context } from 'hono';
import type { AppContext } from '../types';
import type { TokenPayload } from './jwt';
import type { UserSelect } from '../db/schema';
import { verifyToken } from './jwt';
import { getDb } from '../db/client';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { AppError } from '../middleware/error';

/** A message/code pair for one of the ways token authentication can fail. */
export interface AuthFailure {
  message: string;
  code: string;
}

/**
 * Every rejection an authenticated route can raise, spelled out per caller.
 *
 * The access-token middleware and the refresh endpoint reject for the same four
 * reasons but report different messages and codes (e.g. `UNAUTHORIZED` vs
 * `INVALID_REFRESH_TOKEN`), so the differences are supplied rather than shared.
 */
export interface AuthFailureSet {
  /** The token failed signature or expiry verification. */
  invalid: AuthFailure;
  /** The token verified but is of the wrong kind for this endpoint. */
  wrongType: AuthFailure;
  /** The token's `jti` is present in the KV revocation blacklist. */
  revoked: AuthFailure;
  /** The subject no longer exists, or has been deactivated. */
  inactive: AuthFailure;
}

export interface AuthenticatedUser {
  payload: TokenPayload;
  user: UserSelect;
}

/**
 * Verify a raw token and return the active user it identifies.
 *
 * The order of the checks is deliberate and security-relevant:
 *
 * 1. Signature and expiry, so an unverified payload is never trusted.
 * 2. Token kind, so a refresh token cannot be spent as an access token.
 * 3. Revocation, *before* the database. This keeps a revoked token from
 *    costing a D1 round trip, and it means a revoked token whose subject has
 *    since been deleted still reports "revoked" rather than "not found".
 * 4. The user row, so a deleted or deactivated account is rejected even
 *    while its token is still within its validity window.
 */
export async function verifyTokenForUser(
  c: Context<AppContext>,
  rawToken: string,
  secret: string,
  expectedType: TokenPayload['type'],
  failures: AuthFailureSet,
): Promise<AuthenticatedUser> {
  const reject = ({ message, code }: AuthFailure) =>
    new AppError(message, 401, code);

  let payload: TokenPayload;
  try {
    payload = await verifyToken(rawToken, secret);
  } catch {
    throw reject(failures.invalid);
  }

  if (payload.type !== expectedType) {
    throw reject(failures.wrongType);
  }

  const isRevoked = await c.env.CACHE.get(`token:revoked:${payload.jti}`);
  if (isRevoked) {
    throw reject(failures.revoked);
  }

  const user = await getDb(c.env.DB)
    .select()
    .from(users)
    .where(eq(users.id, payload.sub))
    .get();

  if (!user?.isActive) {
    throw reject(failures.inactive);
  }

  return { payload, user };
}

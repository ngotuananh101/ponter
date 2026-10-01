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
  /** The token's `jti` is present in the revocation blacklist. */
  revoked: AuthFailure;
  /** The subject no longer exists, or has been deactivated. */
  inactive: AuthFailure;
}

import type { Context } from 'hono';
import type { AppContext } from '../types.js';
import type { TokenPayload } from './jwt.js';
import type { UserSelect } from '../db/schema.js';
import { verifyToken } from './jwt.js';
import { users, revokedTokens } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { AppError } from '../middleware/error.js';

export interface AuthenticatedUser {
  payload: TokenPayload;
  user: UserSelect;
}

/**
 * Verify a ws-ticket, and nothing else.
 *
 * The mirror of the `authMiddleware` guard: that rejects `scope === 'ws-ticket'`
 * so a ticket can never be spent as an access token, and this rejects every
 * token without the scope so an access token can never be spent as a ticket.
 * A failure here is a thrown `Error` rather than an `AppError` because the
 * caller is a WebSocket upgrade, which answers with a raw HTTP status line
 * instead of Hono's JSON error shape.
 */
export async function verifyWsTicket(
  rawToken: string,
  secret: string,
): Promise<TokenPayload> {
  const payload = await verifyToken(rawToken, secret);
  if (payload.type !== 'access' || payload.scope !== 'ws-ticket') {
    throw new Error('Invalid ws-ticket');
  }
  return payload;
}

/**
 * Verify a raw token and return the active user it identifies.
 *
 * The order of the checks is deliberate and security-relevant:
 *
 * 1. Signature and expiry, so an unverified payload is never trusted.
 * 2. Token kind, so a refresh token cannot be spent as an access token.
 * 3. Revocation, *before* the database. This keeps a revoked token from
 *    costing a round trip, and it means a revoked token whose subject has
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

  // Check revocation in the SQLite `revoked_tokens` table rather than a KV
  // namespace. A row that has already expired past its `expires_at` is treated
  // as not revoked, so stale rows can be cleaned up later.
  const db = c.get('db');
  if (!db) {
    throw reject(failures.invalid);
  }
  const now = Math.floor(Date.now() / 1000);
  const revoked = await db
    .select()
    .from(revokedTokens)
    .where(eq(revokedTokens.jti, payload.jti))
    .get();

  const isRevoked = revoked && revoked.expiresAt > now;
  if (isRevoked) {
    throw reject(failures.revoked);
  }

  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, payload.sub))
    .get();

  if (!user?.isActive) {
    throw reject(failures.inactive);
  }

  return { payload, user };
}

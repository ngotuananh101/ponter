import { eq, and, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';

/**
 * How long a rotated token may be replayed and still return its replacement.
 *
 * Two tabs share one `localStorage` and can refresh at the same instant; the
 * second request presents a token the first has just rotated. Without this
 * window that race would look exactly like theft and revoke the family,
 * logging the user out. Ten seconds is far longer than a round trip and far
 * shorter than any realistic replay window.
 *
 * Read through a function, not a module-level constant, so an operator (or a
 * test) can change `REFRESH_REUSE_GRACE_MS` without re-importing the module.
 */
export function getReuseGraceMs(): number {
  const raw = Number(process.env.REFRESH_REUSE_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
}

export interface StoredRefreshToken {
  jti: string;
  familyId: string;
  userId: string;
  expiresAt: number;
}

export async function storeRefreshToken(
  db: Database,
  token: StoredRefreshToken,
): Promise<void> {
  await db.insert(refreshTokens).values({
    jti: token.jti,
    familyId: token.familyId,
    userId: token.userId,
    expiresAt: token.expiresAt,
  });
}

export async function findRefreshToken(db: Database, jti: string) {
  return db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.jti, jti))
    .get();
}

/**
 * Atomically claim a refresh token for rotation.
 *
 * The `used_at IS NULL` guard is what makes this single-use: two concurrent
 * requests both reach here with `used_at = null` in hand, but only the first
 * UPDATE matches. The loser gets an empty result and must treat the token as
 * already rotated rather than minting a second replacement.
 */
export async function claimRefreshToken(
  db: Database,
  jti: string,
  replacement: { token: string; expiresAt: number },
  usedAt: number,
): Promise<boolean> {
  const rows = await db
    .update(refreshTokens)
    .set({
      usedAt,
      replacedByToken: replacement.token,
      replacedByExpiresAt: replacement.expiresAt,
    })
    .where(and(eq(refreshTokens.jti, jti), isNull(refreshTokens.usedAt)))
    .returning({ jti: refreshTokens.jti });
  return rows.length === 1;
}

/**
 * Delete every token in a family.
 *
 * Deleting (rather than flagging) is what makes reuse detection final: after a
 * family is revoked, no token in it resolves to a row, so `findRefreshToken`
 * returns nothing and every one of them is rejected as invalid.
 */
export async function revokeFamily(
  db: Database,
  familyId: string,
): Promise<void> {
  await db.delete(refreshTokens).where(eq(refreshTokens.familyId, familyId));
}

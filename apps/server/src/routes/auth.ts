import { Hono } from 'hono';
import type { AppContext } from '../types.js';
import { users, revokedTokens } from '../db/schema.js';
import { eq, or, count } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../utils/crypto.js';
import { getSystemSettings } from '../utils/settings.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyToken,
  parseDurationToSeconds,
} from '../utils/jwt.js';
import type { TokenPayload } from '../utils/jwt.js';
import { AppError } from '../middleware/error.js';
import { authMiddleware } from '../middleware/auth.js';
import { verifyTokenForUser } from '../utils/auth.js';
import { toPublicUser } from '../utils/user.js';
import { getJwtSecret, getRefreshSecret } from '../utils/env.js';
import {
  storeRefreshToken,
  findRefreshToken,
  claimRefreshToken,
  revokeFamily,
  getReuseGraceMs,
} from '../utils/refresh-tokens.js';

const auth = new Hono<AppContext>();

const MIN_USERNAME_LENGTH = 3;
const MIN_PASSWORD_LENGTH = 8;

function getAccessTokenTtl(): number {
  const raw = process.env.JWT_EXPIRES_IN;
  if (!raw) {
    return 900;
  }
  return parseDurationToSeconds(raw);
}

function getRefreshTokenTtl(): number {
  const raw = process.env.REFRESH_TOKEN_EXPIRES_IN;
  if (!raw) {
    return 604800;
  }
  return parseDurationToSeconds(raw);
}

auth.post('/register', async (c) => {
  const body = await c.req
    .json<{
      username?: string;
      email?: string;
      password?: string;
      publicKey?: string;
    }>()
    .catch(() => null);

  if (!body?.username || !body?.password || !body?.publicKey) {
    throw new AppError(
      'username, password, and publicKey are required',
      400,
      'VALIDATION_ERROR',
    );
  }

  // Trim before validating so a username of only whitespace cannot slip past
  // the length check, and so uniqueness compares the stored value exactly.
  const username = body.username.trim();
  const publicKey = body.publicKey;
  const password = body.password;

  if (username.length < MIN_USERNAME_LENGTH) {
    throw new AppError(
      'Username must be at least 3 characters',
      400,
      'VALIDATION_ERROR',
    );
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(
      'Password must be at least 8 characters',
      400,
      'VALIDATION_ERROR',
    );
  }

  const db = c.get('db');

  // Enforce the registration gate before creating any user.
  const settings = await getSystemSettings(db);
  if (!settings.allowRegistration) {
    throw new AppError(
      'Registration is currently disabled',
      403,
      'REGISTRATION_DISABLED',
    );
  }

  // Check username or email uniqueness
  const conditions = [eq(users.username, username)];
  if (body.email) {
    conditions.push(eq(users.email, body.email));
  }
  const existing = await db
    .select()
    .from(users)
    .where(or(...conditions))
    .get();

  if (existing) {
    if (existing.username === username) {
      throw new AppError('Username already taken', 409, 'USERNAME_EXISTS');
    }
    throw new AppError('Email already registered', 409, 'EMAIL_EXISTS');
  }

  const passwordHash = await hashPassword(password);

  // Bootstrap logic: the very first registered user becomes an approved admin;
  // every subsequent user is a regular user whose approval status is governed by
  // the `autoApproveUsers` setting (default: pending manual approval).
  //
  // The count check and insert are wrapped in a transaction so that concurrent
  // registrations cannot both observe zero users and both bootstrap as admin.
  // better-sqlite3 transactions are synchronous and SQLite acquires an exclusive
  // write lock, making this race-free.
  const { newUser, approvalStatus } = db.transaction((tx) => {
    const userCountRow = tx.select({ value: count() }).from(users).get();
    const isFirstUser = userCountRow?.value === 0;

    let role: 'admin' | 'user';
    let status: 'pending' | 'approved' | 'rejected';
    if (isFirstUser) {
      role = 'admin';
      status = 'approved';
    } else {
      role = 'user';
      // TEST-ONLY escape hatch for E2E: when E2E_AUTO_APPROVE_USERS='true' is
      // set in the environment, treat auto-approve as on for this registration.
      // This does NOT affect the admin UI / production default (getSystemSettings
      // still returns autoApproveUsers=false by default); it is read here only.
      const e2eAutoApprove = process.env.E2E_AUTO_APPROVE_USERS === 'true';
      status =
        settings.autoApproveUsers || e2eAutoApprove ? 'approved' : 'pending';
    }

    // In a sync transaction, `.returning()` yields a QueryPromise that cannot
    // be awaited; `.all()` executes it synchronously and returns the result rows.
    const createdResults = tx
      .insert(users)
      .values({
        username,
        email: body.email ? body.email : null,
        publicKey,
        passwordHash,
        isActive: true,
        role,
        approvalStatus: status,
      })
      .returning()
      .all();
    const created = createdResults[0];

    if (!created) {
      throw new AppError('Failed to create user', 500, 'DATABASE_ERROR');
    }

    return { newUser: created, approvalStatus: status };
  });

  // Pending users cannot receive tokens — they must wait for admin approval.
  if (approvalStatus === 'pending') {
    return c.json(
      {
        user: toPublicUser(newUser),
        requiresApproval: true,
        message:
          'Registration successful. Your account is pending administrator approval.',
      },
      201,
    );
  }

  const ttl = getAccessTokenTtl();
  const { token, exp } = await signAccessToken(
    newUser.id,
    newUser.username,
    getJwtSecret(),
    ttl,
  );
  const refresh = await signRefreshToken(
    newUser.id,
    getRefreshSecret(),
    getRefreshTokenTtl(),
  );
  await storeRefreshToken(c.get('db'), {
    jti: refresh.jti,
    familyId: refresh.familyId,
    userId: newUser.id,
    expiresAt: refresh.exp,
  });

  return c.json(
    {
      user: toPublicUser(newUser),
      requiresApproval: false,
      token,
      refreshToken: refresh.token,
      expiresIn: exp - Math.floor(Date.now() / 1000),
    },
    201,
  );
});

auth.post('/login', async (c) => {
  const body = await c.req
    .json<{ username?: string; password?: string }>()
    .catch(() => null);

  if (!body?.username || !body?.password) {
    throw new AppError(
      'Username and password are required',
      400,
      'VALIDATION_ERROR',
    );
  }

  const db = c.get('db');
  const user = await db
    .select()
    .from(users)
    .where(eq(users.username, body.username))
    .get();

  if (!user?.passwordHash) {
    throw new AppError(
      'Invalid username or password',
      401,
      'INVALID_CREDENTIALS',
    );
  }

  // Verify the password before reporting account state. Checking `isActive`
  // first would let an unauthenticated caller probe whether a username exists
  // and is deactivated, without ever knowing the password.
  const isValid = await verifyPassword(body.password, user.passwordHash);
  if (!isValid) {
    throw new AppError(
      'Invalid username or password',
      401,
      'INVALID_CREDENTIALS',
    );
  }

  if (user.approvalStatus === 'pending') {
    throw new AppError(
      'Your account is pending administrator approval',
      403,
      'USER_PENDING_APPROVAL',
    );
  }
  if (user.approvalStatus === 'rejected') {
    throw new AppError(
      'Your account registration was rejected',
      403,
      'USER_REJECTED',
    );
  }
  if (!user.isActive) {
    throw new AppError('User account is inactive', 401, 'ACCOUNT_INACTIVE');
  }

  await db
    .update(users)
    .set({ lastLoginAt: new Date().toISOString() })
    .where(eq(users.id, user.id));

  const ttl = getAccessTokenTtl();
  const { token, exp } = await signAccessToken(
    user.id,
    user.username,
    getJwtSecret(),
    ttl,
  );
  const refresh = await signRefreshToken(
    user.id,
    getRefreshSecret(),
    getRefreshTokenTtl(),
  );
  await storeRefreshToken(c.get('db'), {
    jti: refresh.jti,
    familyId: refresh.familyId,
    userId: user.id,
    expiresAt: refresh.exp,
  });

  return c.json({
    user: toPublicUser(user),
    token,
    refreshToken: refresh.token,
    expiresIn: exp - Math.floor(Date.now() / 1000),
  });
});

auth.post('/refresh', async (c) => {
  const body = await c.req.json<{ refreshToken?: string }>().catch(() => null);
  if (!body?.refreshToken) {
    throw new AppError('refreshToken is required', 400, 'VALIDATION_ERROR');
  }

  // The refresh token is held to the same four checks as an access token in
  // `authMiddleware`; only the wording and codes differ, so the shared helper
  // takes those as parameters.
  const { user, payload } = await verifyTokenForUser(
    c,
    body.refreshToken,
    getRefreshSecret(),
    'refresh',
    {
      invalid: {
        message: 'Invalid or expired refresh token',
        code: 'INVALID_REFRESH_TOKEN',
      },
      wrongType: {
        message: 'Invalid token type',
        code: 'INVALID_TOKEN_TYPE',
      },
      revoked: {
        message: 'Refresh token has been revoked',
        code: 'TOKEN_REVOKED',
      },
      inactive: {
        message: 'User is inactive or not found',
        code: 'ACCOUNT_INACTIVE',
      },
    },
  );

  const db = c.get('db');
  const row = await findRefreshToken(db, payload.jti);
  if (!row) {
    // Unknown jti: minted before this migration, or a family already revoked.
    throw new AppError(
      'Invalid or expired refresh token',
      401,
      'INVALID_REFRESH_TOKEN',
    );
  }

  const nowMs = Date.now();
  if (row.usedAt) {
    // `usedAt` is stored in milliseconds so a `REFRESH_REUSE_GRACE_MS=0` test
    // is deterministic: a second use in the same millisecond is still reuse.
    const withinGrace =
      row.replacedByToken &&
      row.replacedByExpiresAt &&
      nowMs - row.usedAt < getReuseGraceMs();
    if (withinGrace) {
      // A concurrent refresh from another tab: hand back the same replacement
      // rather than treating a race as theft.
      const { token, exp } = await signAccessToken(
        user.id,
        user.username,
        getJwtSecret(),
        getAccessTokenTtl(),
      );
      return c.json({
        token,
        refreshToken: row.replacedByToken,
        expiresIn: exp - Math.floor(nowMs / 1000),
      });
    }
    // A rotated token replayed later is theft: burn the whole family.
    await revokeFamily(db, row.familyId);
    throw new AppError(
      'Refresh token reuse detected',
      401,
      'REFRESH_TOKEN_REUSED',
    );
  }

  // Mint the replacement BEFORE claiming — `signRefreshToken` is async and
  // yields the event loop during crypto.subtle.sign, which is exactly the window
  // a concurrent request slides into. Minting early is harmless: if the claim
  // loses we simply discard this replacement.
  const replacement = await signRefreshToken(
    user.id,
    getRefreshSecret(),
    getRefreshTokenTtl(),
    row.familyId,
  );

  const won = await claimRefreshToken(
    db,
    payload.jti,
    { token: replacement.token, expiresAt: replacement.exp },
    nowMs,
  );

  if (won) {
    // You are the winner: persist the new token and return it.
    await storeRefreshToken(db, {
      jti: replacement.jti,
      familyId: replacement.familyId,
      userId: user.id,
      expiresAt: replacement.exp,
    });

    const { token, exp } = await signAccessToken(
      user.id,
      user.username,
      getJwtSecret(),
      getAccessTokenTtl(),
    );
    return c.json({
      token,
      refreshToken: replacement.token,
      expiresIn: exp - Math.floor(nowMs / 1000),
    });
  }

  // You lost the race: another request already rotated this token. Re-read the
  // row so we see its replacement and `usedAt`, then apply the grace logic.
  const updatedRow = await findRefreshToken(db, payload.jti);
  if (
    updatedRow &&
    updatedRow.usedAt &&
    updatedRow.replacedByToken &&
    updatedRow.replacedByExpiresAt &&
    nowMs - updatedRow.usedAt < getReuseGraceMs()
  ) {
    // Within the grace window: hand back the same replacement (multi-tab).
    const { token, exp } = await signAccessToken(
      user.id,
      user.username,
      getJwtSecret(),
      getAccessTokenTtl(),
    );
    return c.json({
      token,
      refreshToken: updatedRow.replacedByToken,
      expiresIn: exp - Math.floor(nowMs / 1000),
    });
  }

  // No replacement or grace elapsed: this is reuse (or a stale token).
  await revokeFamily(db, row.familyId);
  throw new AppError(
    'Refresh token reuse detected',
    401,
    'REFRESH_TOKEN_REUSED',
  );
});

auth.post('/logout', authMiddleware, async (c) => {
  const tokenPayload = c.get('tokenPayload');
  const db = c.get('db');

  const now = Math.floor(Date.now() / 1000);
  const ttl = tokenPayload.exp - now;

  // Record revocation in the SQLite `revoked_tokens` table. `expiresAt` is an
  // absolute Unix timestamp so a cleanup job can garbage-collect stale rows.
  const expiresAt = ttl > 0 ? now + ttl : now + 60;
  await db
    .insert(revokedTokens)
    .values({
      jti: tokenPayload.jti,
      expiresAt,
    })
    .onConflictDoNothing();

  // A logout kills the whole refresh family, not just the presented token:
  // any sibling token from the same login is now unusable.
  const body = await c.req.json<{ refreshToken?: string }>().catch(() => null);
  if (body?.refreshToken) {
    try {
      const refreshPayload: TokenPayload = await verifyToken(
        body.refreshToken,
        getRefreshSecret(),
      );
      if (refreshPayload.fam) {
        await revokeFamily(db, refreshPayload.fam);
      }
    } catch {
      // Ignore invalid refresh token during logout
    }
  }

  return c.json({ success: true });
});

auth.post('/webauthn/options', (c) => {
  return c.json({ error: 'WebAuthn will be supported in Phase 2' }, 501);
});

auth.post('/webauthn/verify', (c) => {
  return c.json({ error: 'WebAuthn will be supported in Phase 2' }, 501);
});

export default auth;

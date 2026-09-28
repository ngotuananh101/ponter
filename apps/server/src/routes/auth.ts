import { Hono } from 'hono';
import type { AppContext } from '../types.js';
import { users, revokedTokens } from '../db/schema.js';
import { eq, or } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../utils/crypto.js';
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

const auth = new Hono<AppContext>();

const MIN_USERNAME_LENGTH = 3;
const MIN_PASSWORD_LENGTH = 8;

function getJwtSecret(): string {
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

function getRefreshSecret(): string {
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

  if (username.length < MIN_USERNAME_LENGTH) {
    throw new AppError(
      'Username must be at least 3 characters',
      400,
      'VALIDATION_ERROR',
    );
  }

  if (body.password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(
      'Password must be at least 8 characters',
      400,
      'VALIDATION_ERROR',
    );
  }

  const db = c.get('db');

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

  const passwordHash = await hashPassword(body.password);
  const userId = crypto.randomUUID();

  const [newUser] = await db
    .insert(users)
    .values({
      id: userId,
      username,
      email: body.email ?? null,
      publicKey: body.publicKey,
      passwordHash,
      isActive: true,
    })
    .returning();

  if (!newUser) {
    throw new AppError('Failed to create user', 500, 'DATABASE_ERROR');
  }

  const ttl = getAccessTokenTtl();
  const { token, exp } = await signAccessToken(
    newUser.id,
    newUser.username,
    getJwtSecret(),
    ttl,
  );
  const { token: refreshToken } = await signRefreshToken(
    newUser.id,
    getRefreshSecret(),
    getRefreshTokenTtl(),
  );

  return c.json(
    {
      user: toPublicUser(newUser),
      token,
      refreshToken,
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
  const { token: refreshToken } = await signRefreshToken(
    user.id,
    getRefreshSecret(),
    getRefreshTokenTtl(),
  );

  return c.json({
    user: toPublicUser(user),
    token,
    refreshToken,
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
  const { user } = await verifyTokenForUser(
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

  const ttl = getAccessTokenTtl();
  const { token, exp } = await signAccessToken(
    user.id,
    user.username,
    getJwtSecret(),
    ttl,
  );

  return c.json({
    token,
    refreshToken: body.refreshToken,
    expiresIn: exp - Math.floor(Date.now() / 1000),
  });
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

  // Also revoke the refresh token if one was passed in the body.
  const body = await c.req.json<{ refreshToken?: string }>().catch(() => null);
  if (body?.refreshToken) {
    try {
      const refreshPayload: TokenPayload = await verifyToken(
        body.refreshToken,
        getRefreshSecret(),
      );
      const refreshTtl = refreshPayload.exp - now;
      await db
        .insert(revokedTokens)
        .values({
          jti: refreshPayload.jti,
          expiresAt: now + (refreshTtl > 0 ? refreshTtl : 60),
        })
        .onConflictDoNothing();
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

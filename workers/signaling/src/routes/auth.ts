import { Hono } from 'hono';
import type { AppContext } from '../types';
import { getDb } from '../db/client';
import { users } from '../db/schema';
import { eq, or } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../utils/crypto';
import { signAccessToken, signRefreshToken, verifyToken } from '../utils/jwt';
import { AppError } from '../middleware/error';
import { authMiddleware } from '../middleware/auth';
import { toPublicUser } from '../utils/user';

const auth = new Hono<AppContext>();

const MIN_USERNAME_LENGTH = 3;
const MIN_PASSWORD_LENGTH = 8;

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

  const db = getDb(c.env.DB);

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

  const { token, exp } = await signAccessToken(
    newUser.id,
    newUser.username,
    c.env.JWT_SECRET,
  );
  const { token: refreshToken } = await signRefreshToken(
    newUser.id,
    c.env.REFRESH_TOKEN_SECRET,
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

  const db = getDb(c.env.DB);
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

  const { token, exp } = await signAccessToken(
    user.id,
    user.username,
    c.env.JWT_SECRET,
  );
  const { token: refreshToken } = await signRefreshToken(
    user.id,
    c.env.REFRESH_TOKEN_SECRET,
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

  let payload;
  try {
    payload = await verifyToken(body.refreshToken, c.env.REFRESH_TOKEN_SECRET);
  } catch {
    throw new AppError(
      'Invalid or expired refresh token',
      401,
      'INVALID_REFRESH_TOKEN',
    );
  }

  if (payload.type !== 'refresh') {
    throw new AppError('Invalid token type', 401, 'INVALID_TOKEN_TYPE');
  }

  const isRevoked = await c.env.CACHE.get(`token:revoked:${payload.jti}`);
  if (isRevoked) {
    throw new AppError('Refresh token has been revoked', 401, 'TOKEN_REVOKED');
  }

  const db = getDb(c.env.DB);
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, payload.sub))
    .get();

  if (!user?.isActive) {
    throw new AppError(
      'User is inactive or not found',
      401,
      'ACCOUNT_INACTIVE',
    );
  }

  const { token, exp } = await signAccessToken(
    user.id,
    user.username,
    c.env.JWT_SECRET,
  );

  return c.json({
    token,
    refreshToken: body.refreshToken,
    expiresIn: exp - Math.floor(Date.now() / 1000),
  });
});

auth.post('/logout', authMiddleware, async (c) => {
  const tokenPayload = c.get('tokenPayload');
  const now = Math.floor(Date.now() / 1000);
  const ttl = tokenPayload.exp - now;

  if (ttl > 0) {
    await c.env.CACHE.put(`token:revoked:${tokenPayload.jti}`, '1', {
      expirationTtl: Math.max(60, ttl),
    });
  }

  // Also revoke refresh token if passed in body
  const body = await c.req.json<{ refreshToken?: string }>().catch(() => null);
  if (body?.refreshToken) {
    try {
      const refreshPayload = await verifyToken(
        body.refreshToken,
        c.env.REFRESH_TOKEN_SECRET,
      );
      const refreshTtl = refreshPayload.exp - now;
      if (refreshTtl > 0) {
        await c.env.CACHE.put(`token:revoked:${refreshPayload.jti}`, '1', {
          expirationTtl: Math.max(60, refreshTtl),
        });
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

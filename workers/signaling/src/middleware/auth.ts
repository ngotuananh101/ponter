import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types';
import { verifyToken } from '../utils/jwt';
import { getDb } from '../db/client';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { AppError } from './error';

export const authMiddleware: MiddlewareHandler<AppContext> = async (
  c,
  next,
) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError(
      'Missing or invalid Authorization header',
      401,
      'UNAUTHORIZED',
    );
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    throw new AppError(
      'Missing or invalid Authorization header',
      401,
      'UNAUTHORIZED',
    );
  }

  let payload;
  try {
    payload = await verifyToken(token, c.env.JWT_SECRET);
  } catch {
    throw new AppError('Invalid or expired token', 401, 'UNAUTHORIZED');
  }

  if (payload.type !== 'access') {
    throw new AppError('Invalid token type', 401, 'UNAUTHORIZED');
  }

  // Fast check KV revocation blacklist
  const isRevoked = await c.env.CACHE.get(`token:revoked:${payload.jti}`);
  if (isRevoked) {
    throw new AppError('Token has been revoked', 401, 'UNAUTHORIZED');
  }

  // Check user active status in D1
  const db = getDb(c.env.DB);
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, payload.sub))
    .get();

  if (!user || !user.isActive) {
    throw new AppError('User is inactive or not found', 401, 'UNAUTHORIZED');
  }

  c.set('user', user);
  c.set('tokenPayload', payload);

  await next();
};

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { authMiddleware } from '../middleware/auth';

const users = new Hono<AppContext>();

// Every /api/users/* route requires a valid access token.
users.use('*', authMiddleware);

users.get('/me', (c) => {
  const user = c.get('user');

  // Explicit projection: `passwordHash` and `metadata` must never leave the
  // worker, so the row is never serialised wholesale.
  const safeUser = {
    id: user.id,
    username: user.username,
    email: user.email,
    publicKey: user.publicKey,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };

  return c.json({ user: safeUser });
});

export default users;

import { Hono } from 'hono';
import type { AppContext } from '../types';
import { authMiddleware } from '../middleware/auth';
import { toPublicUser } from '../utils/user';

const users = new Hono<AppContext>();

// Every /api/users/* route requires a valid access token.
users.use('*', authMiddleware);

users.get('/me', (c) => {
  const user = c.get('user');

  // `passwordHash` and `metadata` must never leave the worker, so the row is
  // never serialised wholesale — it goes through the shared projection.
  return c.json({ user: toPublicUser(user) });
});

export default users;

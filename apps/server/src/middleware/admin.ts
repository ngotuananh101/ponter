import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types.js';
import { AppError } from './error.js';

/**
 * Admin authorization guard.
 *
 * Intended to be mounted *after* `authMiddleware`, so `c.get('user')` is
 * already populated with the authenticated user row. Throws 403 FORBIDDEN
 * for any non-admin caller.
 */
export const adminMiddleware: MiddlewareHandler<AppContext> = async (
  c,
  next,
) => {
  const user = c.get('user');
  if (user?.role !== 'admin') {
    throw new AppError(
      'Forbidden: Admin privileges required',
      403,
      'FORBIDDEN',
    );
  }
  await next();
};

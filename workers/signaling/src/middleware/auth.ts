import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types';
import { AppError } from './error';
import { verifyTokenForUser } from '../utils/auth';

const MISSING_HEADER = 'Missing or invalid Authorization header';

/** Pull the bearer token out of the `Authorization` header. */
function extractBearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    throw new AppError(MISSING_HEADER, 401, 'UNAUTHORIZED');
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new AppError(MISSING_HEADER, 401, 'UNAUTHORIZED');
  }

  return token;
}

export const authMiddleware: MiddlewareHandler<AppContext> = async (
  c,
  next,
) => {
  const token = extractBearerToken(c.req.header('Authorization'));

  const { payload, user } = await verifyTokenForUser(
    c,
    token,
    c.env.JWT_SECRET,
    'access',
    {
      invalid: {
        message: 'Invalid or expired token',
        code: 'UNAUTHORIZED',
      },
      wrongType: { message: 'Invalid token type', code: 'UNAUTHORIZED' },
      revoked: { message: 'Token has been revoked', code: 'UNAUTHORIZED' },
      inactive: {
        message: 'User is inactive or not found',
        code: 'UNAUTHORIZED',
      },
    },
  );

  c.set('user', user);
  c.set('tokenPayload', payload);

  await next();
};

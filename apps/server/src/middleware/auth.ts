import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types.js';
import { AppError } from './error.js';
import { verifyTokenForUser } from '../utils/auth.js';

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
    process.env.JWT_SECRET!,
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

  // Scope separation, REST side. A ws-ticket is a validly signed
  // `type: 'access'` JWT, so without this guard it would authenticate every
  // REST route until its 15s TTL lapsed — and the ticket travels in a query
  // string, which is exactly the channel most likely to leak.
  if (payload.scope === 'ws-ticket') {
    throw new AppError('WS ticket rejected by REST', 401, 'UNAUTHORIZED');
  }

  c.set('user', user);
  c.set('tokenPayload', payload);

  await next();
};

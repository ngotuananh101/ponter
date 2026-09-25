import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
    public code = 'BAD_REQUEST',
    public details: unknown = null,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        details: err.details,
      },
      err.statusCode as ContentfulStatusCode,
    );
  }

  // Handle JSON parse errors or malformed payloads.
  // Hono's `c.req.json()` throws a bare `SyntaxError` (no `status` property),
  // so `instanceof SyntaxError` is the discriminator that actually fires.
  if (err instanceof SyntaxError) {
    return c.json(
      {
        error: 'Malformed JSON payload',
        code: 'MALFORMED_JSON',
        details: null,
      },
      400,
    );
  }

  console.error('[Unhandled Error]', err);
  return c.json(
    {
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
      details: null,
    },
    500,
  );
};

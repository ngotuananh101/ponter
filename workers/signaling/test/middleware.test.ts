import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware } from '../src/middleware/auth';
import { errorHandler, AppError } from '../src/middleware/error';
import { corsMiddleware } from '../src/middleware/cors';
import { signAccessToken, signRefreshToken } from '../src/utils/jwt';
import type { AppContext } from '../src/types';
import { RESET_STATEMENTS, TEST_JWT_SECRET } from './helpers';

const MIDDLEWARE_RESET_STATEMENTS = [
  ...RESET_STATEMENTS,
  `INSERT INTO users (id, username, public_key, is_active) VALUES ('usr_active', 'alice', 'pk_1', 1)`,
  `INSERT INTO users (id, username, public_key, is_active) VALUES ('usr_inactive', 'eve', 'pk_2', 0)`,
];

describe('Auth Middleware & Token Revocation', () => {
  let app: Hono<AppContext>;

  beforeEach(async () => {
    await env.DB.batch(
      MIDDLEWARE_RESET_STATEMENTS.map((sql) => env.DB.prepare(sql)),
    );

    app = new Hono<AppContext>();
    app.onError(errorHandler);
    app.use('/protected/*', authMiddleware);
    app.get('/protected/profile', (c) => c.json({ user: c.get('user') }));
  });

  it('rejects requests without Authorization header with 401', async () => {
    const res = await app.request('/protected/profile', {}, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Missing or invalid Authorization header');
  });

  it('allows active user with valid token', async () => {
    const { token } = await signAccessToken(
      'usr_active',
      'alice',
      TEST_JWT_SECRET,
    );
    const res = await app.request(
      '/protected/profile',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...env, JWT_SECRET: TEST_JWT_SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string } };
    expect(body.user.username).toBe('alice');
  });

  it('rejects revoked token recorded in KV CACHE with 401', async () => {
    const { token, jti } = await signAccessToken(
      'usr_active',
      'alice',
      TEST_JWT_SECRET,
    );
    // Put token in revocation blacklist in KV
    await env.CACHE.put(`token:revoked:${jti}`, '1');

    const res = await app.request(
      '/protected/profile',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...env, JWT_SECRET: TEST_JWT_SECRET },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Token has been revoked');
  });

  it('consults KV revocation before querying D1', async () => {
    // Token is revoked AND its subject does not exist in D1. The two checks
    // produce different errors, so the message tells us which ran first: a
    // DB-first implementation would report 'User is inactive or not found'.
    const { token, jti } = await signAccessToken(
      'usr_ghost',
      'ghost',
      TEST_JWT_SECRET,
    );
    await env.CACHE.put(`token:revoked:${jti}`, '1');

    const res = await app.request(
      '/protected/profile',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...env, JWT_SECRET: TEST_JWT_SECRET },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Token has been revoked');
  });

  it('rejects inactive user with 401 even if token is valid', async () => {
    const { token } = await signAccessToken(
      'usr_inactive',
      'eve',
      TEST_JWT_SECRET,
    );
    const res = await app.request(
      '/protected/profile',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...env, JWT_SECRET: TEST_JWT_SECRET },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('User is inactive or not found');
  });

  it('rejects a refresh token used as an access token', async () => {
    const { token } = await signRefreshToken('usr_active', TEST_JWT_SECRET);
    const res = await app.request(
      '/protected/profile',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...env, JWT_SECRET: TEST_JWT_SECRET },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid token type');
  });

  it('rejects a token signed with the wrong secret', async () => {
    const { token } = await signAccessToken(
      'usr_active',
      'alice',
      'a-completely-different-secret-value',
    );
    const res = await app.request(
      '/protected/profile',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...env, JWT_SECRET: TEST_JWT_SECRET },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid or expired token');
  });
});

describe('Global Error Handler', () => {
  let app: Hono<AppContext>;

  beforeEach(() => {
    app = new Hono<AppContext>();
    app.onError(errorHandler);
    app.get('/app-error', () => {
      throw new AppError('Teapot', 418, 'TEAPOT', { hint: 'short and stout' });
    });
    app.get('/unexpected', () => {
      throw new Error('kaboom');
    });
    app.post('/echo', async (c) => c.json(await c.req.json()));
  });

  it('formats AppError with its status, code and details', async () => {
    const res = await app.request('/app-error', {}, env);
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({
      error: 'Teapot',
      code: 'TEAPOT',
      details: { hint: 'short and stout' },
    });
  });

  it('returns 400 MALFORMED_JSON for an unparseable body', async () => {
    const res = await app.request(
      '/echo',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-json',
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Malformed JSON payload',
      code: 'MALFORMED_JSON',
      details: null,
    });
  });

  it('returns 500 INTERNAL_SERVER_ERROR for an unknown error', async () => {
    const res = await app.request('/unexpected', {}, env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
      details: null,
    });
  });

  it('passes through a Hono HTTPException response unchanged', async () => {
    // Hono's own `HTTPException` carries a complete response; the handler must
    // return it as-is rather than flattening it to a 500.
    const app = new Hono<AppContext>();
    app.onError(errorHandler);
    app.get('/not-found', () => {
      throw new HTTPException(404, { message: 'Nothing here' });
    });

    const res = await app.request('/not-found', {}, env);
    expect(res.status).toBe(404);
    // `HTTPException`'s default response is `text/plain`, carrying its message.
    expect(await res.text()).toBe('Nothing here');
  });
});

describe('CORS Middleware', () => {
  it('answers a preflight request with CORS headers', async () => {
    const app = new Hono<AppContext>();
    app.use('*', corsMiddleware);
    app.get('/anything', (c) => c.json({ ok: true }));

    const res = await app.request(
      '/anything',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.com',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Authorization',
        },
      },
      env,
    );

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain(
      'Authorization',
    );
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });
});

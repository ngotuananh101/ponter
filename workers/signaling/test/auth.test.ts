import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';

/**
 * Response shapes asserted by this suite. Kept as local types rather than
 * `any` so the tests stay type-checked and lint-clean (the repo enables
 * `@typescript-eslint/no-explicit-any` as an error).
 */
type PublicUser = {
  id: string;
  username: string;
  email: string | null;
  publicKey: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

type AuthResponse = {
  user: PublicUser;
  token: string;
  refreshToken: string;
  expiresIn: number;
};

type RefreshResponse = {
  token: string;
  refreshToken: string;
  expiresIn: number;
};

type ErrorResponse = {
  error: string;
  code: string;
  details: unknown;
};

/**
 * `D1Database.exec()` splits its input on newlines, so a multi-line
 * `CREATE TABLE` is torn apart mid-statement. `D1Database.batch()` takes one
 * prepared statement per array entry, keeping each statement's exact
 * multi-line SQL while still running them sequentially and atomically.
 *
 * The `users` DDL mirrors the Drizzle schema in `src/db/schema.ts` — including
 * `last_login_at` and `metadata`, which the login/register routes write to.
 */
const RESET_STATEMENTS = [
  'DROP TABLE IF EXISTS signals',
  'DROP TABLE IF EXISTS audit_logs',
  'DROP TABLE IF EXISTS sessions',
  'DROP TABLE IF EXISTS agents',
  'DROP TABLE IF EXISTS devices',
  'DROP TABLE IF EXISTS users',
  `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT UNIQUE,
        public_key TEXT NOT NULL,
        password_hash TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT,
        metadata TEXT
      )`,
];

describe('Auth & Users REST API', () => {
  beforeEach(async () => {
    await env.DB.batch(RESET_STATEMENTS.map((sql) => env.DB.prepare(sql)));
  });

  it('registers a new user and returns 201 with tokens', async () => {
    const res = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'alice',
          email: 'alice@example.com',
          password: 'Password123!',
          publicKey: 'pk_alice_ed25519',
        }),
      },
      env,
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as AuthResponse;
    expect(body.user.username).toBe('alice');
    expect(body.token).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    expect(body.expiresIn).toBe(900);
  });

  it('rejects registration with duplicate username with 409', async () => {
    await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'bob',
          email: 'bob@example.com',
          password: 'Password123!',
          publicKey: 'pk_bob',
        }),
      },
      env,
    );

    const dupRes = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'bob',
          email: 'bob2@example.com',
          password: 'Password123!',
          publicKey: 'pk_bob_2',
        }),
      },
      env,
    );

    expect(dupRes.status).toBe(409);
    const err = (await dupRes.json()) as ErrorResponse;
    expect(err.code).toBe('USERNAME_EXISTS');
  });

  it('logs in successfully and fetches /api/users/me', async () => {
    // 1. Register
    await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'charlie',
          password: 'SecretPassword!',
          publicKey: 'pk_charlie',
        }),
      },
      env,
    );

    // 2. Login
    const loginRes = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'charlie',
          password: 'SecretPassword!',
        }),
      },
      env,
    );

    expect(loginRes.status).toBe(200);
    const loginData = (await loginRes.json()) as AuthResponse;
    const token = loginData.token;

    // 3. Fetch profile
    const profileRes = await app.request(
      '/api/users/me',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      env,
    );

    expect(profileRes.status).toBe(200);
    const profile = (await profileRes.json()) as { user: PublicUser };
    expect(profile.user.username).toBe('charlie');
  });

  it('refreshes token via /api/auth/refresh', async () => {
    const regRes = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'david',
          password: 'Password123!',
          publicKey: 'pk_david',
        }),
      },
      env,
    );
    const { refreshToken } = (await regRes.json()) as AuthResponse;

    const refreshRes = await app.request(
      '/api/auth/refresh',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      },
      env,
    );

    expect(refreshRes.status).toBe(200);
    const refreshData = (await refreshRes.json()) as RefreshResponse;
    expect(refreshData.token).toBeDefined();
  });

  it('revokes token on logout so subsequent requests fail with 401', async () => {
    const regRes = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'emma',
          password: 'Password123!',
          publicKey: 'pk_emma',
        }),
      },
      env,
    );
    const { token } = (await regRes.json()) as AuthResponse;

    // Logout
    const logoutRes = await app.request(
      '/api/auth/logout',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      env,
    );
    expect(logoutRes.status).toBe(200);

    // Profile request with old token must now be 401
    const profileRes = await app.request(
      '/api/users/me',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      env,
    );
    expect(profileRes.status).toBe(401);
  });

  it('returns 501 Not Implemented on WebAuthn stubs', async () => {
    const optRes = await app.request(
      '/api/auth/webauthn/options',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'test' }),
      },
      env,
    );
    expect(optRes.status).toBe(501);

    const verRes = await app.request(
      '/api/auth/webauthn/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: {} }),
      },
      env,
    );
    expect(verRes.status).toBe(501);
  });
});

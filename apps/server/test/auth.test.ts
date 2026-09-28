import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';
import type { Database } from '../src/db/client';
import { users } from '../src/db/schema';

// In-process secrets for tests. These satisfy the "at least some entropy"
// expectation without depending on the real deployment env vars.
const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

process.env.JWT_SECRET = JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = REFRESH_TOKEN_SECRET;

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

describe('Auth & Users REST API', () => {
  let db: Database;

  beforeEach(async () => {
    db = getDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('registers a new user and returns 201 with tokens', async () => {
    const app = createApp();
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice',
        email: 'alice@example.com',
        password: 'Password123!',
        publicKey: 'pk_alice_ed25519',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as AuthResponse;
    expect(body.user.username).toBe('alice');
    expect(body.token).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    expect(body.expiresIn).toBe(900);
  });

  it('rejects registration with duplicate username with 409', async () => {
    const app = createApp();
    await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'bob',
        email: 'bob@example.com',
        password: 'Password123!',
        publicKey: 'pk_bob',
      }),
    });

    const dupRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'bob',
        email: 'bob2@example.com',
        password: 'Password123!',
        publicKey: 'pk_bob_2',
      }),
    });

    expect(dupRes.status).toBe(409);
    const err = (await dupRes.json()) as ErrorResponse;
    expect(err.code).toBe('USERNAME_EXISTS');
  });

  it('logs in successfully and fetches /api/users/me', async () => {
    const app = createApp();

    // 1. Register
    await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'charlie',
        password: 'SecretPassword!',
        publicKey: 'pk_charlie',
      }),
    });

    // 2. Login
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'charlie',
        password: 'SecretPassword!',
      }),
    });

    expect(loginRes.status).toBe(200);
    const loginData = (await loginRes.json()) as AuthResponse;
    const token = loginData.token;

    // 3. Fetch profile
    const profileRes = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(profileRes.status).toBe(200);
    const profile = (await profileRes.json()) as { user: PublicUser };
    expect(profile.user.username).toBe('charlie');
  });

  it('rejects login with wrong password with 401 INVALID_CREDENTIALS', async () => {
    const app = createApp();

    await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'frank',
        password: 'Password123!',
        publicKey: 'pk_frank',
      }),
    });

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'frank', password: 'WrongPassword!' }),
    });

    expect(res.status).toBe(401);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('INVALID_CREDENTIALS');
  });

  it('refreshes token via /api/auth/refresh', async () => {
    const app = createApp();

    const regRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'david',
        password: 'Password123!',
        publicKey: 'pk_david',
      }),
    });
    const { refreshToken } = (await regRes.json()) as AuthResponse;

    const refreshRes = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    expect(refreshRes.status).toBe(200);
    const refreshData = (await refreshRes.json()) as RefreshResponse;
    expect(refreshData.token).toBeDefined();
  });

  it('revokes token on logout so subsequent requests fail with 401', async () => {
    const app = createApp();

    const regRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'emma',
        password: 'Password123!',
        publicKey: 'pk_emma',
      }),
    });
    const { token } = (await regRes.json()) as AuthResponse;

    // Logout
    const logoutRes = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(logoutRes.status).toBe(200);

    // Profile request with old token must now be 401
    const profileRes = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(profileRes.status).toBe(401);
  });

  it('rejects registration with a password shorter than 8 characters', async () => {
    const app = createApp();
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'shortpass',
        password: 'short',
        publicKey: 'pk_shortpass',
      }),
    });

    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('rejects registration with a username shorter than 3 characters', async () => {
    const app = createApp();
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'ab',
        password: 'Password123!',
        publicKey: 'pk_shortuser',
      }),
    });

    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('rejects /api/users/me without Authorization header with 401', async () => {
    const app = createApp();
    const res = await app.request('/api/users/me', {});
    expect(res.status).toBe(401);
  });

  it('rejects /api/users/me with a revoked access token with 401', async () => {
    const app = createApp();

    const regRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'victor',
        password: 'Password123!',
        publicKey: 'pk_victor',
      }),
    });
    const { token } = (await regRes.json()) as AuthResponse;

    // Logout revokes the token
    await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    const profileRes = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(profileRes.status).toBe(401);
    const err = (await profileRes.json()) as ErrorResponse;
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('rejects a refresh token used as an access token', async () => {
    const app = createApp();

    const regRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'wendy',
        password: 'Password123!',
        publicKey: 'pk_wendy',
      }),
    });
    const { refreshToken } = (await regRes.json()) as AuthResponse;

    const res = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${refreshToken}` },
    });

    expect(res.status).toBe(401);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('rejects unknown username on login with INVALID_CREDENTIALS', async () => {
    const app = createApp();
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ghost', password: 'Password123!' }),
    });

    expect(res.status).toBe(401);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns INVALID_REFRESH_TOKEN when refresh body is missing', async () => {
    const app = createApp();
    const res = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('persists users across requests via the shared DB singleton', async () => {
    const app = createApp();

    await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'zoe',
        password: 'Password123!',
        publicKey: 'pk_zoe',
      }),
    });

    // Direct DB read to confirm the row was persisted
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.username).toBe('zoe');
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';
import { claimRefreshToken } from '../src/utils/refresh-tokens.js';

process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';
process.env.E2E_AUTO_APPROVE_USERS = 'true';

async function register(app: ReturnType<typeof createApp>, username: string) {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'Password123!', publicKey: 'pk' }),
  });
  return (await res.json()) as { token: string; refreshToken: string };
}

async function refresh(app: ReturnType<typeof createApp>, refreshToken: string) {
  const res = await app.request('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

beforeEach(() => {
  closeDb();
  getDb(':memory:');
  vi.unstubAllEnvs();
});

describe('refresh token rotation', () => {
  it('issues a different refresh token on each use', async () => {
    const app = createApp();
    const { refreshToken } = await register(app, 'alice');
    const first = await refresh(app, refreshToken);
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(refreshToken);
    const second = await refresh(app, first.body.refreshToken!);
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.body.refreshToken);
  });

  it('returns the same replacement inside the grace window (multi-tab)', async () => {
    const app = createApp();
    const { refreshToken } = await register(app, 'bob');
    const first = await refresh(app, refreshToken);
    const retry = await refresh(app, refreshToken);
    expect(retry.status).toBe(200);
    expect(retry.body.refreshToken).toBe(first.body.refreshToken);
  });

  it('revokes the family when a rotated token is reused after the grace window', async () => {
    vi.stubEnv('REFRESH_REUSE_GRACE_MS', '0');
    const app = createApp();
    const { refreshToken } = await register(app, 'carol');
    const first = await refresh(app, refreshToken);
    const reuse = await refresh(app, refreshToken);
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');
    // The family is dead: the replacement is now rejected too.
    const after = await refresh(app, first.body.refreshToken!);
    expect(after.status).toBe(401);
  });

  it('claims a refresh token atomically: a second claim on the same jti loses', async () => {
    const app = createApp();
    const { refreshToken } = await register(app, 'dave');
    const db = getDb();
    // Extract the jti from the refresh token payload (no secret needed to read payload).
    const payloadJson = JSON.parse(
      atob(refreshToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
    ) as { jti: string; fam: string; exp: number; sub: string };
    const first = await claimRefreshToken(db, payloadJson.jti, {
      token: 'replacement-1',
      expiresAt: payloadJson.exp,
    }, Date.now());
    expect(first).toBe(true);
    const second = await claimRefreshToken(db, payloadJson.jti, {
      token: 'replacement-2',
      expiresAt: payloadJson.exp,
    }, Date.now());
    expect(second).toBe(false);
  });
});

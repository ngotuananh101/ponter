import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

const REG = { password: 'Password123!', publicKey: 'pk' };

async function login(
  app: ReturnType<typeof createApp>,
  username: string,
  password: string,
  ip = '10.0.0.1',
) {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ username, password }),
  });
}

async function register(app: ReturnType<typeof createApp>, username: string) {
  await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...REG, username }),
  });
}

beforeEach(() => {
  closeDb();
  getDb(':memory:');
});

describe('login rate limiting', () => {
  it('returns 429 after five failed attempts from one IP', async () => {
    const app = createApp();
    await register(app, 'alice');
    for (let i = 0; i < 5; i++) {
      const res = await login(app, 'alice', 'wrong', '10.0.0.9');
      expect(res.status).toBe(401);
    }
    const blocked = await login(app, 'alice', 'wrong', '10.0.0.9');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('does not lock out a different IP for the same username', async () => {
    const app = createApp();
    await register(app, 'bob');
    for (let i = 0; i < 6; i++) await login(app, 'bob', 'wrong', '10.0.0.9');
    const victim = await login(app, 'bob', 'Password123!', '10.0.0.7');
    expect(victim.status).toBe(200);
  });

  it('resets the counter after a successful login', async () => {
    const app = createApp();
    await register(app, 'carol');
    for (let i = 0; i < 4; i++) await login(app, 'carol', 'wrong', '10.0.0.3');
    expect((await login(app, 'carol', 'Password123!', '10.0.0.3')).status).toBe(200);
    for (let i = 0; i < 4; i++) await login(app, 'carol', 'wrong', '10.0.0.3');
    expect((await login(app, 'carol', 'wrong', '10.0.0.3')).status).toBe(401);
  });
});

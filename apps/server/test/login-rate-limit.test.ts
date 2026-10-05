import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';
import { MAX_KEYS } from '../src/middleware/login-rate-limit.js';

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

  it('uses the rightmost X-Forwarded-For entry, ignoring a forged prefix', async () => {
    const app = createApp();
    await register(app, 'dave');
    // Each request carries a different forged prefix but the SAME rightmost IP.
    for (let i = 0; i < 5; i++) {
      const res = await login(app, 'dave', 'wrong', `forged-${i}, 10.0.0.9`);
      expect(res.status).toBe(401);
    }
    // A different forged prefix but the same rightmost IP must still be 429.
    const blocked = await login(app, 'dave', 'wrong', 'attacker, 10.0.0.9');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('fails closed with 429 when the entry table is full and a new key arrives', async () => {
    const app = createApp();
    // Fill the Map to its cap with one failure per distinct rightmost IP.
    // No registration: non-existent user → fast 401 without password verification.
    for (let i = 0; i < MAX_KEYS; i++) {
      const res = await login(app, 'nobody', 'wrong', `ip-${i}`);
      expect(res.status).toBe(401);
    }
    // One more distinct IP: Map is at cap, key is new → fail closed (429).
    const overflow = await login(app, 'nobody', 'wrong', 'ip-overflow');
    expect(overflow.status).toBe(429);
    // An existing key at the cap still works normally (not fail-closed).
    const existing = await login(app, 'nobody', 'wrong', 'ip-0');
    expect(existing.status).toBe(401);
  }, 60_000);

  it('admits at most one new key when a concurrent burst arrives at the cap', async () => {
    const app = createApp();
    // Fill to MAX_KEYS - 1 with distinct keys (distinct rightmost IPs; non-existent
    // user -> fast 401, no password hashing).
    for (let i = 0; i < MAX_KEYS - 1; i++) {
      const res = await login(app, `filler-${i}`, 'wrong', `filler-ip-${i}`);
      expect(res.status).toBe(401);
    }
    // Concurrent burst of NEW keys from one IP (distinct usernames => distinct keys).
    const N = 200;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => login(app, `burst-${i}`, 'wrong', '10.0.0.99')),
    );
    const admitted = results.filter((r) => r.status === 401).length;
    const rejected = results.filter((r) => r.status === 429).length;
    // THE distinguishing assertion: a correct cap admits EXACTLY ONE new key into
    // the single remaining slot. The broken (racy) version admitted all N, so
    // "exactly 1" is what separates fixed from broken. "after-burst 429" alone is
    // NOT sufficient — a Map that exceeded the cap also returns 429.
    expect(admitted).toBe(1);
    expect(rejected).toBe(N - 1);
    // A further genuinely-new key must fail closed.
    const overflow = await login(app, 'after-burst', 'wrong', '10.0.0.99');
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get('Retry-After')).toBeTruthy();
  }, 120_000);
});

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';
import {
  MAX_KEYS,
  createLoginRateLimiterForTest,
} from '../src/middleware/login-rate-limit.js';
import type { AppContext } from '../src/types.js';
import auth from '../src/routes/auth.js';
import { cors } from 'hono/cors';
import { errorHandler } from '../src/middleware/error.js';

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

/**
 * Build a Hono app wired with the login rate limiter factory under test and the
 * auth routes, mounting the limiter so its live `entries` map is observable.
 * Mirrors the wiring in `createApp()` but lets the test inject the limiter.
 */
function createAppForTest(
  middleware: ReturnType<typeof createLoginRateLimiterForTest>['middleware'],
): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('db', getDb(process.env.DATABASE_PATH));
    await next();
  });
  app.use('/api/auth/login', middleware);
  app.route('/api/auth', auth);
  return app;
}

beforeEach(() => {
  closeDb();
  getDb(':memory:');
});

describe('login rate limiting', () => {
  // Must match MAX_KEYS exported from login-rate-limit.ts
  const TEST_MAX_KEYS = 5000;

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
    for (let i = 0; i < TEST_MAX_KEYS; i++) {
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

  it('does not grow past MAX_KEYS under a concurrent burst of new keys', async () => {
    const burst = 200;

    // Pre-condition: the limiter exposes a live entry map so the test can assert
    // the bounded invariant directly. `MAX_KEYS - 1` distinct keys are inserted
    // first; the burst then fires `burst` genuinely-new keys concurrently to
    // provoke the check/insert straddle across `await next()` that this test
    // exists to guard.
    const limiter = createLoginRateLimiterForTest();
    const app2 = createAppForTest(limiter.middleware);

    // Fill to MAX_KEYS - 1 with one failure per distinct rightmost IP/username.
    for (let i = 0; i < MAX_KEYS - 1; i++) {
      const res = await login(app2, `filler-${i}`, 'wrong', `filler-ip-${i}`);
      // Every pre-fill is a distinct key -> 401 (new key admitted, counter=1).
      expect(res.status).toBe(401);
    }
    expect(limiter.entries.size).toBe(MAX_KEYS - 1);

    // Concurrent burst of NEW keys (distinct usernames, same IP is fine because
    // the username differs, yielding distinct keys) from one IP.
    const requests = Array.from({ length: burst }, (_, i) =>
      login(app2, `attacker-${i}`, 'wrong', '10.0.0.99'),
    );
    const results = await Promise.allSettled(requests);

    // Invariant: the table never exceeds the hard cap, regardless of scheduling.
    expect(limiter.entries.size).toBeLessThanOrEqual(MAX_KEYS);

    // Every burst request was either admitted (401) or rejected (429), never an
    // unhandled rejection and never a leak past the cap.
    let admitted = 0;
    let rejected = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const s = r.value.status;
        if (s === 401) admitted++;
        else if (s === 429) rejected++;
        else throw new Error(`unexpected status ${s}`);
      } else {
        throw new Error(`unexpected rejection: ${String(r.reason)}`);
      }
    }
    // At least one burst member must have been rejected at the cap (admitted
    // + rejected == burst). If every member was admitted the cap was breached.
    expect(rejected).toBeGreaterThan(0);
    expect(admitted + rejected).toBe(burst);

    // One more genuinely-new key after the burst: with the cap breached the old
    // code admitted it; the fix must fail closed with 429.
    const overflow = await login(app2, 'after-burst', 'wrong', '10.0.0.99');
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get('Retry-After')).toBeTruthy();
  });
});

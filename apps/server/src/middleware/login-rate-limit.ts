import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types.js';

export interface LoginRateLimitOptions {
  /** Failed attempts allowed per key before the key is blocked. */
  maxFailures?: number;
  /** How long a failure is remembered, and how long a block lasts. */
  windowMs?: number;
  /** Injectable clock, so a test can advance time without waiting. */
  now?: () => number;
}

interface Entry {
  failures: number;
  resetAt: number;
}

/**
 * Per-(IP, username) lockout for the login endpoint.
 *
 * Only 401 responses count as failures and a 200 clears the key, so a
 * legitimate user never accumulates budget: the counter measures *wrong
 * passwords*, not logins. A pending-approval 403 is not counted, because the
 * caller proved the password and the block is an account state, not a guess.
 *
 * The key includes the client IP as well as the username. Keying on the
 * username alone would let anyone lock a victim out of their own account by
 * failing logins on the victim's name; keying on IP alone would let one
 * attacker behind NAT exhaust the budget for everyone behind it.
 *
 * State is a `Map` created per call, so each `createApp()` gets an independent
 * limiter — a test cannot inherit another test's lockouts.
 */
export function createLoginRateLimiter(
  options: LoginRateLimitOptions = {},
): MiddlewareHandler<AppContext> {
  const maxFailures = options.maxFailures ?? 5;
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();

  return async (c, next) => {
    const key = `${clientIp(c)}|${await peekUsername(c)}`;
    const t = now();
    const entry = entries.get(key);

    if (entry && entry.failures >= maxFailures && t < entry.resetAt) {
      const retryAfter = Math.ceil((entry.resetAt - t) / 1000);
      return c.json(
        {
          error: 'Too many login attempts. Try again later.',
          code: 'TOO_MANY_REQUESTS',
          details: { retryAfter },
        },
        429,
        { 'Retry-After': String(retryAfter) },
      );
    }
    if (entry && t >= entry.resetAt) entries.delete(key);

    await next();

    if (c.res.status === 401) {
      const current = entries.get(key);
      const base =
        current && t < current.resetAt
          ? current
          : { failures: 0, resetAt: t + windowMs };
      base.failures += 1;
      entries.set(key, base);
    } else if (c.res.status === 200) {
      entries.delete(key);
    }
  };
}

/** The client address, honouring the proxy header a deployment terminates on. */
function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  // `X-Forwarded-For` is trusted here because the only deployment that sets it
  // is the bundled reverse proxy, which overwrites it. A deployment exposed
  // directly to the internet would let a client forge the header and dodge the
  // limiter; that deployment must set the header at its own edge or remove
  // this branch.
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? 'unknown';
}

/**
 * Read the username without consuming the request body.
 *
 * The login handler reads the body itself, and a Hono request body can be read
 * once, so this clones the underlying `Request` before parsing. A body that is
 * absent or not JSON yields `''`, which still participates in the key.
 */
async function peekUsername(c: {
  req: { raw: Request };
}): Promise<string> {
  try {
    const body = (await c.req.raw.clone().json()) as { username?: unknown };
    return typeof body?.username === 'string'
      ? body.username.trim().toLowerCase()
      : '';
  } catch {
    return '';
  }
}

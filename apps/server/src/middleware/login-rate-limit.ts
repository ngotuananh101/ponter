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
 * Hard cap on the number of distinct (IP, username) keys retained in memory.
 *
 * Every deployment must run behind one of the bundled proxies (see below), so
 * the X-Forwarded-For value the server sees is always set by an operator
 * controlled component — never trusted from the edge directly. Even so, a
 * determined attacker can still cause one entry to be allocated per unique
 * rightmost-IP + username pair. Capping the table at 5000 entries prevents
 * unbounded memory growth while allowing hundreds of concurrent users to be
 * rate-limited independently.
 */
export const MAX_KEYS = 5000;

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

    // For a NEW key: sweep expired entries, then enforce the hard cap.
    // An existing key is unaffected by the cap — it continues to work normally
    // even when the Map is full, so a legitimate user already tracked cannot be
    // evicted by a flood of new requests.
    if (!entries.has(key)) {
      for (const [k, e] of entries) {
        if (e.resetAt <= t) entries.delete(k);
      }
      if (entries.size >= MAX_KEYS) {
        // Fail closed: refusing a new key at cap is safer than unbounded
        // Map growth (DoS amplification) or evicting an arbitrary entry.
        // The window gives an upper bound on how long until entries expire
        // and a slot frees up.
        const retryAfter = Math.ceil(windowMs / 1000);
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
    }

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

/**
 * The client address, honouring the proxy header a deployment terminates on.
 *
 * IP TRUST MODEL — every deployment MUST run behind one of the bundled proxies.
 * The rightmost entry of X-Forwarded-For is the address of the hop that
 * actually delivered the request to this server: each proxy in the chain
 * (nginx with `$proxy_add_x_forwarded_for`, Cloudflare Tunnel) APPENDS the peer
 * it received the connection from, so a client can only PREPEND forged values
 * on the left which remain inert. Caddy (no `trusted_proxies` in docker/Caddyfile)
 * sets XFF itself, so leftmost == rightmost.
 *
 * DIRECT EXPOSURE IS UNSUPPORTED: with no proxy in front, BOTH X-Forwarded-For
 * and X-Real-IP are entirely client-controlled; IP keying is unverifiable and
 * meaningless in that topology. "Supported topologies" means behind the bundled
 * proxy.
 */
function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    // Split on commas, trim whitespace, and take the LAST non-empty entry.
    // Every proxy appends the connecting hop's address on the right; the client
    // can only prepend forged values on the left.
    const parts = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }
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

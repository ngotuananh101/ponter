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

    if (entries.has(key)) {
      const existing = entries.get(key)!;
      // A window that has fully elapsed resets the entry in place: the previous
      // failures have aged out, so start a fresh window for this attempt. This
      // mirrors the pre-fix behaviour where a stale entry was deleted and a
      // fresh one created.
      if (existing.resetAt <= t) {
        existing.failures = 0;
        existing.resetAt = t + windowMs;
      }
    } else {
      // NEW key: sweep expired entries, then enforce the hard cap.
      // An existing key is unaffected by the cap — it continues to work normally
      // even when the Map is full, so a legitimate user already tracked cannot be
      // evicted by a flood of new requests.
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
      // RESERVE THE SLOT SYNCHRONOUSLY — in the same synchronous block as the
      // cap check, before any `await`. This closes the race the cap check is
      // meant to prevent: previously the insert straddled `await next()`, so a
      // concurrent burst of new keys at size==MAX_KEYS-1 all passed the guard,
      // all suspended, and then all committed their insert past the cap. By
      // inserting the reserved entry here (failures:0, resetAt: t+windowMs)
      // before yielding, check + insert can never be separated by a context
      // switch, and the Map can never grow past MAX_KEYS.
      entries.set(key, { failures: 0, resetAt: t + windowMs });
    }

    const entry = entries.get(key)!;

    if (entry.failures >= maxFailures && t < entry.resetAt) {
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

    await next();

    if (c.res.status === 401) {
      // Increment the reserved/in-flight entry in place. We never re-insert a
      // fresh object on a new 401 here (that would reset resetAt and discard
      // the synchronous reservation's budget accounting); the entry was either
      // just reserved above or carried over from a prior window reset, so a
      // plain increment is correct.
      entry.failures += 1;
    } else if (c.res.status === 200) {
      // A successful login clears the key: a legitimate user never accumulates
      // budget. The reserved slot (if any) is released.
      entries.delete(key);
    } else {
      // A non-401/non-200 response (e.g. pending-approval 403) does not
      // increment budget. A NEW key's reserved slot ages out with its window;
      // it is not released here.
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
function clientIp(c: {
  req: { header: (name: string) => string | undefined };
}): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    // Split on commas, trim whitespace, and take the LAST non-empty entry.
    // Every proxy appends the connecting hop's address on the right; the client
    // can only prepend forged values on the left.
    const parts = forwarded
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
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
async function peekUsername(c: { req: { raw: Request } }): Promise<string> {
  try {
    const body = (await c.req.raw.clone().json()) as { username?: unknown };
    return typeof body?.username === 'string'
      ? body.username.trim().toLowerCase()
      : '';
  } catch {
    return '';
  }
}

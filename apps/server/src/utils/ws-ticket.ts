/**
 * One-time registry for WebSocket tickets.
 *
 * A ticket is a short-lived JWT; this registry is what makes it one-time.
 * The mint route registers the `jti`; the upgrade handler consumes it. A
 * second consume returns false, so a ticket leaked through a proxy access
 * log cannot open a second socket even within its TTL.
 *
 * In-memory by design: the server is a single replica (see the plan's D1 /
 * Risks), so a `Map` is authoritative. A multi-replica deployment would
 * need a shared store, at which point REST polling remains the safe path.
 *
 * Expired entries are removed lazily on register — no timer, because the
 * registry only grows by the number of live tickets (a handful per second
 * at this scale), and a timer would be one more thing to shut down.
 */
const tickets = new Map<string, number>(); // jti -> expiresAtMs

export function registerWsTicket(jti: string, ttlMs = 15_000): void {
  const now = Date.now();
  for (const [key, expiresAt] of tickets) {
    if (expiresAt <= now) tickets.delete(key);
  }
  tickets.set(jti, now + ttlMs);
}

/** Returns true exactly once per registered, unexpired ticket. */
export function consumeWsTicket(jti: string): boolean {
  const expiresAt = tickets.get(jti);
  if (expiresAt === undefined || expiresAt <= Date.now()) {
    return false;
  }
  tickets.delete(jti);
  return true;
}

/**
 * How the signalling socket ended, as far as the reconnect loop cares (M2).
 *
 * 4409 = this agent was replaced by a newer connection; 4401 = the credential
 * was rejected. Reconnecting against either flaps a server that has already
 * decided, and in the 4409 case would evict the connection that replaced this
 * one. Everything else — 1000, 1001, 1013, an unmapped application code, or no
 * close frame at all — is a death the next attempt can plausibly fix.
 *
 * A pure function over `number | null` on purpose: the close-code policy is the
 * part that can be tested without a socket, and the part that must not drift.
 */
export type RunEnd = { kind: 'terminal'; code: number } | { kind: 'transient' };

const TERMINAL_CODES = new Set([4401, 4409]);

export function classifyClose(code: number | null): RunEnd {
  if (code !== null && TERMINAL_CODES.has(code))
    return { kind: 'terminal', code };
  return { kind: 'transient' };
}

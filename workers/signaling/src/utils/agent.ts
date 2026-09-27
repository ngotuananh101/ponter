import type { Agent as SharedAgent } from '@remote/shared';
import type { AgentSelect } from '../db/schema';
import { buf2hex } from './crypto';

/** The shared contract, not a hand-copied shape (Week 5 D32). */
export type PublicAgent = SharedAgent;

/**
 * How long a `last_ping_at` stays credible. The agent pings every 30s, so this
 * is three missed pings.
 */
export const ONLINE_WINDOW_SECONDS = 90;

/**
 * `YYYY-MM-DD HH:MM:SS` in UTC — the exact shape `datetime('now')` writes.
 *
 * Deliberately not `toISOString()`: the `T` separator sorts after the space, so
 * an ISO string is lexicographically greater than every SQLite timestamp. The
 * slice drops the milliseconds and the `Z`; the replace swaps in the space.
 */
function sqliteNow(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The only definition of "online" in the codebase.
 *
 * Two conditions, not one. A live socket in the in-memory map is not sufficient
 * — a half-open TCP connection keeps the entry while the agent is gone. A fresh
 * `last_ping_at` is not sufficient either — the socket is what a push needs.
 *
 * `socketPresent` is passed in rather than read here because `ws.ts` imports
 * this module; reading `agentConnections` from here would close the cycle.
 * `nowMs` is injectable so the window is testable without faking timers.
 *
 * `is_online` in D1 is only a hint: nothing clears it when an agent goes dark,
 * so every consumer must come through this function and never read the column
 * alone.
 */
export function isAgentOnline(
  agent: { isOnline: boolean; lastPingAt: string | null },
  socketPresent: boolean,
  nowMs: number = Date.now(),
): boolean {
  if (!socketPresent || agent.isOnline !== true || !agent.lastPingAt) {
    return false;
  }

  // Both operands are space-separated UTC, so a lexicographic compare is a
  // chronological one. `Date.parse` is avoided: it reads a space-separated
  // string as local time in Node and as UTC in workerd.
  return agent.lastPingAt > sqliteNow(nowMs - ONLINE_WINDOW_SECONDS * 1000);
}

/**
 * `ag_` + 32 lowercase hex characters: 16 bytes of CSPRNG output, 128 bits.
 *
 * The prefix makes the credential greppable in logs and instantly
 * distinguishable from a JWT, which matters because it is the one secret that
 * must never appear in one.
 */
export function generateAgentCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ag_${buf2hex(bytes.buffer)}`;
}

/**
 * `capabilities` is stored as a JSON string. A malformed value, a non-array, or
 * non-string members all collapse to `[]` rather than throwing: this runs on
 * the response path of every agent route, and a bad column value must not turn
 * a list request into a 500.
 */
export function parseCapabilities(raw: string | null): string[] {
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/**
 * Project an `agents` row onto the wire contract.
 *
 * This is a security boundary, not a convenience: after migration 0002 the row
 * carries `credential_hash`, so returning a row wholesale would hand every
 * caller the hash of every agent the user owns. `credentialHash` is absent from
 * the literal below by construction, so it cannot be spread in later.
 *
 * `last_ping_at` is exposed as `lastHeartbeat` because the shared `Agent`
 * contract names it that (`packages/shared/src/types/user.ts:39`); the rename
 * happens here and nowhere else.
 */
export function toPublicAgent(
  agent: AgentSelect,
  socketPresent: boolean,
): PublicAgent {
  return {
    id: agent.id,
    userId: agent.userId,
    hostname: agent.hostname,
    platform: agent.platform,
    osVersion: agent.osVersion,
    agentVersion: agent.agentVersion,
    publicKey: agent.publicKey,
    isOnline: isAgentOnline(agent, socketPresent),
    lastHeartbeat: agent.lastPingAt,
    capabilities: parseCapabilities(agent.capabilities),
    createdAt: agent.createdAt,
  };
}

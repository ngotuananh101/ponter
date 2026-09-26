import type { Agent as SharedAgent } from '@remote/shared';
import type { AgentSelect } from '../db/schema';
import { buf2hex } from './crypto';

/** The shared contract, not a hand-copied shape (Week 5 D32). */
export type PublicAgent = SharedAgent;

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
export function toPublicAgent(agent: AgentSelect): PublicAgent {
  return {
    id: agent.id,
    userId: agent.userId,
    hostname: agent.hostname,
    platform: agent.platform,
    osVersion: agent.osVersion,
    agentVersion: agent.agentVersion,
    publicKey: agent.publicKey,
    isOnline: agent.isOnline,
    lastHeartbeat: agent.lastPingAt,
    capabilities: parseCapabilities(agent.capabilities),
    createdAt: agent.createdAt,
  };
}

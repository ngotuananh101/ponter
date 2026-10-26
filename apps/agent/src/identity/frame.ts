// apps/agent/src/identity/frame.ts
import type { AgentIdentity } from './store.js';

/**
 * The agent→server WS2 identity frame (B48's agent side).
 *
 * The signed bytes are a two-line string, not the JSON: signing the serialized
 * frame would make the signature depend on key order and whitespace, so a
 * server implementation in another language could not reproduce it. The
 * `nonce=` line is the challenge echo that makes the signature fresh — without
 * it a captured frame replays forever.
 */
export const AGENT_IDENTITY_SIGNING_PREFIX = 'ponter-ws2-agent-identity-v1';

export function buildAgentIdentityFrame(
  nonce: string,
  identity: AgentIdentity,
): string {
  const message = `${AGENT_IDENTITY_SIGNING_PREFIX}\nnonce=${nonce}`;
  const signature = identity.sign(new TextEncoder().encode(message));
  return JSON.stringify({
    type: 'agent-identity',
    data: {
      nonce,
      publicKey: identity.publicKeyBase64,
      signature: Buffer.from(signature).toString('base64'),
    },
  });
}

/**
 * The canonical WS2 peer-identity proof.
 *
 * Both the browser (WebCrypto) and the Rust agent (`ring`) sign and verify the
 * EXACT same UTF-8 bytes. Every field is on its own line, the version tag is
 * first, and no field is optional: a signature over this string is bound to the
 * role (no offer/answer reflection), the session (no cross-session replay), the
 * exact SDP, and the exact DTLS fingerprint.
 */
export const PROOF_VERSION = 'ponter-ws2-v1';

export type PeerRole = 'offerer' | 'answerer';

export interface CanonicalProofInput {
  role: PeerRole;
  sessionId: string;
  sdpSha256Hex: string;
  fingerprint: string;
}

export function canonicalProofMessage(input: CanonicalProofInput): string {
  return [
    PROOF_VERSION,
    `role=${input.role}`,
    `sessionId=${input.sessionId}`,
    `sdpSha256=${input.sdpSha256Hex}`,
    `fingerprint=${input.fingerprint}`,
  ].join('\n');
}

const FP_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31}$/;

/**
 * Normalize a DTLS certificate fingerprint to uppercase colon-separated hex.
 *
 * Accepts either the full SDP line (`a=fingerprint:sha-256 AB:CD:…`) or the bare
 * value, because the two peers read it from different places (the browser from
 * the answer SDP text, the agent from the offer SDP text) but must compare
 * equal. Throws on anything that is not 32 SHA-256 byte pairs, so a truncated
 * or non-hex value fails closed instead of comparing as "different".
 */
export function normalizeFingerprint(raw: string): string {
  const value = raw.trim().replace(/^a=fingerprint:[^ ]+\s+/i, '');
  if (!FP_RE.test(value)) {
    throw new Error(`malformed DTLS fingerprint: ${JSON.stringify(raw)}`);
  }
  return value.toUpperCase();
}

/**
 * Extract the first `a=fingerprint:sha-256 …` line from an SDP string.
 */
export function parseSdpFingerprint(sdp: string): string {
  for (const line of sdp.split(/\r?\n/)) {
    if (/^a=fingerprint:/i.test(line.trim())) {
      return normalizeFingerprint(line.trim());
    }
  }
  throw new Error('SDP carries no a=fingerprint line');
}

/**
 * WS1 (Phase 5) application-layer E2EE — shared, byte-pinned constants and the
 * canonical key-binding message.
 *
 * The ECDH public key a peer advertises is trusted only when it carries an
 * Ed25519 signature (by the WS2 identity key) over the exact string this module
 * produces. The reference implementation is shared with the Rust agent (Week 16);
 * changing any string here is a wire-contract change.
 */
export const WS1_KEY_VERSION = 'ponter-ws1-v1';

/** HKDF `info` for the terminal data channel. */
export const WS1_TERMINAL_INFO = 'ponter-ws1-terminal-v1';

/** The exact UTF-8 string a peer signs to bind its ECDH key to its identity. */
export function canonicalKeyBinding(ecdhPublicKeySpkiBase64: string): string {
  return `${WS1_KEY_VERSION}\necdhPublicKey=${ecdhPublicKeySpkiBase64}`;
}

/** A peer's ECDH public key plus the identity signature that authenticates it. */
export interface E2eeKeyBinding {
  /** SPKI-encoded ECDH P-256 public key, base64. */
  ecdhPublicKey: string;
  /** Ed25519 signature (base64) over `canonicalKeyBinding(ecdhPublicKey)`. */
  signature: string;
}

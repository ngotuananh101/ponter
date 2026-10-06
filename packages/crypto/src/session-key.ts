import { canonicalKeyBinding, WS1_TERMINAL_INFO } from '@ponter/shared';
import { EncryptionManager } from './encrypt';
import { importPublicKeySpki, verifyProof } from './index';

/** Parameters for deriving a WS1 terminal session key. */
export interface BuildSessionKeyParams {
  /** Our own ECDH private key (non-extractable; from local storage). */
  myEcdhPrivateKey: CryptoKey;
  /** The peer's SPKI-base64 ECDH public key, as carried in its hello/ack. */
  peerEcdhPublicKeySpkiBase64: string;
  /** The peer's Ed25519 signature over `canonicalKeyBinding(peerEcdhPublicKey)`. */
  peerBindingSignature: string;
  /** The peer's Ed25519 signing public key (from the WS2 handshake). */
  peerSigningPublicKey: CryptoKey;
  /** The WebRTC session id; used as the HKDF salt. */
  sessionId: string;
}

/**
 * Verify the peer's identity signature over its ECDH key, then derive the
 * session key. Throws if the binding does not verify — the caller must fall
 * back to plaintext, never adopt an unverified key.
 */
export async function buildSessionKey(
  params: BuildSessionKeyParams,
): Promise<EncryptionManager> {
  const message = canonicalKeyBinding(params.peerEcdhPublicKeySpkiBase64);
  const ok = await verifyProof(
    params.peerSigningPublicKey,
    message,
    params.peerBindingSignature,
  );
  if (!ok) {
    throw new Error('WS1 key binding did not verify against the peer identity');
  }
  const peerEcdhPublicKey = await importPublicKeySpki(
    params.peerEcdhPublicKeySpkiBase64,
  );
  return EncryptionManager.derive(
    params.myEcdhPrivateKey,
    peerEcdhPublicKey,
    new TextEncoder().encode(WS1_TERMINAL_INFO),
    new TextEncoder().encode(params.sessionId),
  );
}

import {
  buildSessionKey,
  generateUserKeyPair,
  importSigningPublicKeyRaw,
  type EncryptionManager,
} from '@ponter/crypto';
import { canonicalKeyBinding } from '@ponter/shared';
import { decodeBase64Strict } from '../base64.js';
import type { AgentIdentity } from '../identity/store.js';

export { WS1_TERMINAL_INFO } from '@ponter/shared';

export interface E2eeHello {
  terminalId: string;
  ecdhPublicKey: string;
  signature: string;
}

export interface E2eeAck {
  terminalId: string;
  ecdhPublicKey: string;
  signature: string;
}

/**
 * Answerer-side WS1 terminal E2EE, porting `E2eeSession` from `apps/agent/src/e2ee.rs`.
 *
 * **There is no `begin` step, and that is deliberate.** The agent is the
 * answerer: the browser sends `terminal-e2ee-hello` first, and the Rust's
 * `accept_hello` (`e2ee.rs:198-220`) generates our ephemeral key *inside* the
 * call, after verifying the peer, returning the session and the signed ack
 * together. An `AgentE2ee` that pre-allocated a pending session in one call and
 * armed it in another carried three states nothing could distinguish (never
 * begun / begun-unarmed / armed) and an ordering nobody enforced.
 *
 * **The signature is verified before the session key is derived, and the session
 * object does not exist until it verifies** — the Rust's doc comment states the
 * reason: "a session that exists is always a session that may encrypt".
 */
export class E2eeSession {
  private constructor(private readonly manager: EncryptionManager) {}

  /**
   * Verify the peer's hello, derive the session key, and return our signed ack.
   *
   * `sessionId` is a **parameter, with no default**: it comes off the wire with
   * the session being negotiated and is the HKDF salt (`@ponter/crypto`'s
   * `buildSessionKey`; Rust `e2ee.rs:220`). A defaulted salt is a silent seam
   * break — the agent arms, reports success, and then fails every GCM tag
   * because the browser derived under its real session id. Required is the only
   * safe shape.
   *
   * `peerSigningPublicKeyRawBase64` is the **raw 32-byte** Ed25519 key the offer
   * carried (Rust `&[u8; 32]`, `lib.rs:1250-1258`), not SPKI DER.
   *
   * Fail-closed: a bad signature, a malformed key or a failed import returns
   * `null`. The caller then stays plaintext and sends no ack.
   */
  static async acceptHello(
    identity: AgentIdentity,
    sessionId: string,
    hello: E2eeHello,
    peerSigningPublicKeyRawBase64: string,
  ): Promise<{ session: E2eeSession; ack: E2eeAck } | null> {
    try {
      // Strict, as `e2ee.rs:76-90` is (`E2eeError::Encoding` on a bad decode).
      // `Buffer.from(x, 'base64')` silently skips non-alphabet characters, so a
      // key with junk *inserted* decodes to the identical 32 bytes and would be
      // accepted here while the Rust refuses it; junk *substituted* decodes to
      // 32 different bytes and fails as a bad signature instead of an encoding
      // error. Both are classification defects at this boundary, not key
      // problems — the value never should have reached `importSigningPublicKeyRaw`.
      const raw = decodeBase64Strict(peerSigningPublicKeyRawBase64);
      if (raw?.length !== 32) return null;

      // 1. Our ephemeral keypair, generated ONCE: the private half derives the
      //    session key and the public half goes out in the ack, and those must be
      //    the same key or the browser derives a different secret.
      //
      //    This sits *before* the verify because `buildSessionKey` needs our
      //    private half as an input — the Rust verifies first and generates
      //    second (`e2ee.rs:210-216`). The divergence is safe and deliberate: an
      //    ephemeral keypair is a throwaway that touches no state and escapes
      //    nothing until an ack is returned, and the property the Rust's ordering
      //    protects — "a session that exists is always a session that may
      //    encrypt" — is kept because `E2eeSession` is constructed only after
      //    `buildSessionKey` resolves, and `buildSessionKey` throws when the
      //    binding does not verify.
      //
      //    Nothing about the binding is built locally: the verified string is
      //    `canonicalKeyBinding(ecdhPublicKey)` and the HKDF salt is
      //    `sessionId`, the two values the browser and the Rust also use.
      const keyPair = await generateUserKeyPair();
      const manager = await buildSessionKey({
        myEcdhPrivateKey: keyPair.privateKey,
        peerEcdhPublicKeySpkiBase64: hello.ecdhPublicKey,
        peerBindingSignature: hello.signature,
        peerSigningPublicKey: await importSigningPublicKeyRaw(
          peerSigningPublicKeyRawBase64,
        ),
        sessionId,
      });

      // 2. Build our signed ack so the browser can derive the identical key.
      const ackSignature = identity.sign(
        new TextEncoder().encode(
          canonicalKeyBinding(keyPair.publicKeySpkiBase64),
        ),
      );
      const ack: E2eeAck = {
        terminalId: hello.terminalId,
        ecdhPublicKey: keyPair.publicKeySpkiBase64,
        signature: Buffer.from(ackSignature).toString('base64'),
      };

      return { session: new E2eeSession(manager), ack };
    } catch {
      return null;
    }
  }

  /**
   * Both directions keep the **rejection** contract of the `EncryptionManager`
   * they delegate to: callers `await` these, and a synchronous throw from a
   * delegate would escape before a promise exists. `decrypt` is the reachable
   * one — the crypto layer rejects on a short frame or a failed GCM tag, and
   * `manager.test.ts:180` asserts `rejects.toThrow()` — so a bare throw would
   * red that cell. `encrypt` is wrapped for the same reason, not because its
   * delegate currently throws.
   */
  encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    try {
      return Promise.resolve(this.manager.encrypt(plaintext));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  decrypt(framed: Uint8Array): Promise<Uint8Array> {
    try {
      return Promise.resolve(this.manager.decrypt(framed));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

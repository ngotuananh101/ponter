import {
  buildSessionKey,
  exportPublicKeySpki,
  signProof,
} from '@ponter/crypto';
import type { EncryptionManager } from '@ponter/crypto';
import {
  canonicalKeyBinding,
  type TerminalE2eeAck,
  type TerminalE2eeHello,
} from '@ponter/shared';

/** The keys a browser needs to run terminal E2EE for one session. */
export interface E2eeContext {
  /** Our own ECDH private key (non-extractable; from local storage). */
  ecdhPrivateKey: CryptoKey;
  /** Our own ECDH public key (for the signed binding we advertise). */
  ecdhPublicKey: CryptoKey;
  /** Our Ed25519 signing private key (WS2 identity). */
  signingPrivateKey: CryptoKey;
  /** The peer's Ed25519 signing public key (verified by WS2). */
  peerSigningPublicKey: CryptoKey;
  /** The WebRTC session id; used as the HKDF salt. */
  sessionId: string;
}

/**
 * WS1 terminal E2EE negotiation (Phase 5, Week 15).
 *
 * Dormant until negotiated: `isActive()` is false and `encrypt`/`decrypt` are
 * identity, so a caller that never negotiates sends plaintext unchanged. The key
 * is derived only after the peer's ECDH key is proven (Ed25519 signature over
 * the canonical binding). Any verification failure throws and leaves the session
 * plaintext — never half-encrypted.
 */
export class TerminalE2ee {
  private manager: EncryptionManager | null = null;

  constructor(private readonly ctx: E2eeContext) {}

  /** True for the two frame types that drive negotiation. */
  static isNegotiationFrame(type: string): boolean {
    return type === 'terminal-e2ee-hello' || type === 'terminal-e2ee-ack';
  }

  isActive(): boolean {
    return this.manager !== null;
  }

  private async binding(): Promise<{
    ecdhPublicKey: string;
    signature: string;
  }> {
    const ecdhPublicKey = await exportPublicKeySpki(this.ctx.ecdhPublicKey);
    const signature = await signProof(
      this.ctx.signingPrivateKey,
      canonicalKeyBinding(ecdhPublicKey),
    );
    return { ecdhPublicKey, signature };
  }

  /** Offerer side: build our hello. */
  async buildHello(terminalId: string): Promise<TerminalE2eeHello> {
    return { terminalId, ...(await this.binding()) };
  }

  /** Answerer side: verify the hello, derive the key, return our ack. */
  async handleHello(hello: TerminalE2eeHello): Promise<TerminalE2eeAck> {
    const manager = await buildSessionKey({
      myEcdhPrivateKey: this.ctx.ecdhPrivateKey,
      peerEcdhPublicKeySpkiBase64: hello.ecdhPublicKey,
      peerBindingSignature: hello.signature,
      peerSigningPublicKey: this.ctx.peerSigningPublicKey,
      sessionId: this.ctx.sessionId,
    });
    const ack = { terminalId: hello.terminalId, ...(await this.binding()) };
    this.manager = manager;
    return ack;
  }

  /** Offerer side: verify the peer's ack and derive the key. */
  async handleAck(ack: TerminalE2eeAck): Promise<void> {
    this.manager = await buildSessionKey({
      myEcdhPrivateKey: this.ctx.ecdhPrivateKey,
      peerEcdhPublicKeySpkiBase64: ack.ecdhPublicKey,
      peerBindingSignature: ack.signature,
      peerSigningPublicKey: this.ctx.peerSigningPublicKey,
      sessionId: this.ctx.sessionId,
    });
  }

  async encrypt(data: Uint8Array): Promise<Uint8Array> {
    return this.manager ? this.manager.encrypt(data) : data;
  }

  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    return this.manager ? this.manager.decrypt(data) : data;
  }
}

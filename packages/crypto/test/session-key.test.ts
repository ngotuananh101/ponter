import { describe, it, expect } from 'vitest';
import {
  generateUserKeyPair,
  generateSigningKeyPair,
  signProof,
  importSigningPublicKeyRaw,
  exportPublicKeySpki,
  buildSessionKey,
} from '../src/index';
import { canonicalKeyBinding } from '@ponter/shared';

async function makeBinding(signingKey: CryptoKey, ecdhSpki: string) {
  return signProof(signingKey, canonicalKeyBinding(ecdhSpki));
}

describe('WS1 session-key binding', () => {
  it('derives a working key when the peer binding verifies', async () => {
    const aliceEcdh = await generateUserKeyPair();
    const bobEcdh = await generateUserKeyPair();
    const bobSigning = await generateSigningKeyPair();
    const bobSpki = await exportPublicKeySpki(bobEcdh.publicKey);

    const key = await buildSessionKey({
      myEcdhPrivateKey: aliceEcdh.privateKey,
      peerEcdhPublicKeySpkiBase64: bobSpki,
      peerBindingSignature: await makeBinding(bobSigning.privateKey, bobSpki),
      peerSigningPublicKey: await importSigningPublicKeyRaw(
        bobSigning.publicKeyRawBase64,
      ),
      sessionId: 'session-1',
    });

    const framed = await key.encrypt(new TextEncoder().encode('hi'));
    expect(framed.length).toBeGreaterThan(12);
  });

  it('refuses a binding signed by a different identity (fail closed)', async () => {
    const aliceEcdh = await generateUserKeyPair();
    const bobEcdh = await generateUserKeyPair();
    const bobSigning = await generateSigningKeyPair();
    const mallorySigning = await generateSigningKeyPair();
    const bobSpki = await exportPublicKeySpki(bobEcdh.publicKey);

    await expect(
      buildSessionKey({
        myEcdhPrivateKey: aliceEcdh.privateKey,
        peerEcdhPublicKeySpkiBase64: bobSpki,
        peerBindingSignature: await makeBinding(
          mallorySigning.privateKey,
          bobSpki,
        ),
        peerSigningPublicKey: await importSigningPublicKeyRaw(
          bobSigning.publicKeyRawBase64,
        ),
        sessionId: 'session-1',
      }),
    ).rejects.toThrow(/key binding/i);
  });

  it('refuses a signature made over a different ECDH key', async () => {
    const aliceEcdh = await generateUserKeyPair();
    const bobEcdh = await generateUserKeyPair();
    const otherEcdh = await generateUserKeyPair();
    const bobSigning = await generateSigningKeyPair();
    const bobSpki = await exportPublicKeySpki(bobEcdh.publicKey);
    const otherSpki = await exportPublicKeySpki(otherEcdh.publicKey);

    await expect(
      buildSessionKey({
        myEcdhPrivateKey: aliceEcdh.privateKey,
        peerEcdhPublicKeySpkiBase64: bobSpki,
        peerBindingSignature: await makeBinding(
          bobSigning.privateKey,
          otherSpki,
        ),
        peerSigningPublicKey: await importSigningPublicKeyRaw(
          bobSigning.publicKeyRawBase64,
        ),
        sessionId: 'session-1',
      }),
    ).rejects.toThrow(/key binding/i);
  });
});

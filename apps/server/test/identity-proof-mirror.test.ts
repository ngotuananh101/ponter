import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  canonicalUserIdentityMessage as serverMirror,
  verifyUserIdentityProof,
} from '../src/utils/identity-proof';
import {
  canonicalUserIdentityMessage as sharedSource,
  USER_IDENTITY_PROOF_PREFIX,
} from '@ponter/shared';

// The server keeps a local copy of this pure function because @ponter/shared
// ships TypeScript source and the production image runs compiled JS — a runtime
// import would crash the server at boot (ERR_MODULE_NOT_FOUND). These tests pin
// the mirror to the shared source so the two can never drift: the browser signs
// the shared string and the server verifies the mirror, so a divergence would
// silently break signing-key bootstrap.
describe('canonicalUserIdentityMessage (server mirror)', () => {
  const inputs = [
    'u1',
    'user-abc-123',
    '',
    '  spaced  ',
    'unicode-✓-🚀',
    'with=newline\nin=id',
    'a'.repeat(500),
  ];

  it('matches @ponter/shared byte-for-byte on representative inputs', () => {
    for (const id of inputs) {
      expect(serverMirror(id)).toBe(sharedSource(id));
    }
  });

  it('uses the shared version prefix', () => {
    expect(serverMirror('u1')).toBe(`${USER_IDENTITY_PROOF_PREFIX}\nuserId=u1`);
  });

  it('is byte-stable across calls', () => {
    expect(serverMirror('u1')).toBe(serverMirror('u1'));
  });
});

/** Generate an Ed25519 keypair; return base64 public key + a signer closure. */
async function makeKeypair() {
  const kp = await webcrypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]);
  const raw = await webcrypto.subtle.exportKey('raw', kp.publicKey);
  return {
    publicKeyB64: Buffer.from(raw).toString('base64'),
    async sign(message: string): Promise<string> {
      return Buffer.from(
        await webcrypto.subtle.sign(
          'Ed25519',
          kp.privateKey,
          new TextEncoder().encode(message),
        ),
      ).toString('base64');
    },
  };
}

describe('verifyUserIdentityProof (server mirror)', () => {
  it('returns true for a valid Ed25519 signature', async () => {
    const kp = await makeKeypair();
    const userId = 'u_test_valid';
    const message = serverMirror(userId);
    const signature = await kp.sign(message);

    const result = await verifyUserIdentityProof(
      userId,
      kp.publicKeyB64,
      signature,
    );

    expect(result).toBe(true);
  });

  it('returns false for a valid signature over a different userId', async () => {
    const kp = await makeKeypair();
    const signature = await kp.sign(serverMirror('attacker-controlled-id'));

    const result = await verifyUserIdentityProof(
      'victim-id',
      kp.publicKeyB64,
      signature,
    );

    expect(result).toBe(false);
  });

  it('returns false for a malformed base64 signingPublicKey without throwing', async () => {
    const userId = 'u_test_malformed_pubkey';
    const message = serverMirror(userId);
    const kp = await makeKeypair();
    const signature = await kp.sign(message);

    await expect(
      verifyUserIdentityProof(userId, 'not!!!valid!!!base64!!!', signature),
    ).resolves.toBe(false);
  });

  it('returns false for a malformed base64 signature without throwing', async () => {
    const kp = await makeKeypair();
    const userId = 'u_test_malformed_sig';

    await expect(
      verifyUserIdentityProof(
        userId,
        kp.publicKeyB64,
        'not!!!valid!!!base64!!!',
      ),
    ).resolves.toBe(false);
  });

  it('returns false for an all-zero signature (valid base64, verifies false)', async () => {
    const kp = await makeKeypair();
    const userId = 'u_test_false_sig';
    const falseSignature = 'AAAAAAAAAAAAAAAAAAAAAA==';

    const result = await verifyUserIdentityProof(
      userId,
      kp.publicKeyB64,
      falseSignature,
    );

    expect(result).toBe(false);
  });

  it('returns false for a signature from a different keypair', async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();
    const userId = 'u_test_cross_key';
    const message = serverMirror(userId);
    const signature = await kp1.sign(message);

    // Verify with kp2's public key — signature won't match.
    const result = await verifyUserIdentityProof(
      userId,
      kp2.publicKeyB64,
      signature,
    );

    expect(result).toBe(false);
  });
});

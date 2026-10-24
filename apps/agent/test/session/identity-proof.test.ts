// apps/agent/test/session/identity-proof.test.ts
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalProofMessage } from '@ponter/shared';
import { describe, expect, it } from 'vitest';
import {
  advertisesE2ee,
  verifyOfferIdentity,
} from '../../src/session/identity-proof.js';

const SESSION = 'sess-abc';
const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  `a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89`,
  '',
].join('\r\n');
const FINGERPRINT =
  'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const SDP_SHA256 = createHash('sha256').update(SDP, 'utf8').digest('hex');

function keypair() {
  // The wire form is the browser's `publicKeyRawBase64` — **raw 32 bytes**
  // (`apps/web/src/stores/auth.ts:226,296`, set from `exportSigningPublicKeyRaw`,
  // `packages/crypto/src/index.ts:307`), relayed verbatim by the server
  // (`apps/server/src/routes/signal.ts:106-117`) and decoded into `[u8; 32]` by
  // the Rust (`apps/agent/src/lib.rs:1250-1258`). Deriving it the SPKI way
  // (`export({ type: 'spki', format: 'der' })`, 44 bytes) is what made this
  // fence certify its own bug: it exercised a shape no peer ever sends.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(
    (publicKey.export({ format: 'jwk' }) as { x: string }).x,
    'base64url',
  );
  return {
    privateKey,
    userSigningPublicKey: raw.toString('base64'),
  };
}

function offerWith(overrides: Record<string, unknown> = {}) {
  const { privateKey, userSigningPublicKey } = keypair();
  const message = canonicalProofMessage({
    role: 'offerer',
    sessionId: SESSION,
    sdpSha256Hex: SDP_SHA256,
    fingerprint: FINGERPRINT,
  });
  const signature = sign(null, Buffer.from(message), privateKey).toString(
    'base64',
  );
  return {
    type: 'offer' as const,
    data: {
      sessionId: SESSION,
      sdp: SDP,
      userSigningPublicKey,
      proof: { fingerprint: FINGERPRINT, signature },
      capabilities: ['e2ee'],
      ...overrides,
    },
  };
}

describe('verifyOfferIdentity', () => {
  it('accepts a correctly signed offer', () => {
    expect(() => verifyOfferIdentity(offerWith(), SESSION)).not.toThrow();
  });

  it('refuses an offer carrying no proof', () => {
    expect(() =>
      verifyOfferIdentity(offerWith({ proof: undefined }), SESSION),
    ).toThrow(/carries no identity proof/);
  });

  it('refuses an offer carrying no user signing key', () => {
    expect(() =>
      verifyOfferIdentity(
        offerWith({ userSigningPublicKey: undefined }),
        SESSION,
      ),
    ).toThrow(/carries no user signing key/);
  });

  it('refuses a malformed SDP fingerprint before touching the proof', () => {
    const offer = offerWith({
      sdp: 'v=0\r\na=fingerprint:nonsense\r\n',
    }) as never;
    expect(() => verifyOfferIdentity(offer, SESSION)).toThrow(/fingerprint/);
  });

  it('refuses a proof fingerprint that disagrees with the SDP', () => {
    const other = FINGERPRINT.replace('AB', 'AF');
    const offer = offerWith({
      proof: { fingerprint: other, signature: 'AA==' },
    }) as never;
    expect(() => verifyOfferIdentity(offer, SESSION)).toThrow(/does not match/);
  });

  it('accepts a proof fingerprint written in lowercase', () => {
    // The Rust normalizes `proof.fingerprint` before comparing it
    // (`lib.rs:1006` -> `identity.rs:128`), so a lowercase-but-valid proof
    // verifies. The canonical message is built from the SDP-derived
    // fingerprint, so normalizing the proof side changes only the comparison.
    const { privateKey, userSigningPublicKey } = keypair();
    const message = canonicalProofMessage({
      role: 'offerer',
      sessionId: SESSION,
      sdpSha256Hex: SDP_SHA256,
      fingerprint: FINGERPRINT,
    });
    const signature = sign(null, Buffer.from(message), privateKey).toString(
      'base64',
    );
    const offer = {
      type: 'offer' as const,
      data: {
        sessionId: SESSION,
        sdp: SDP,
        userSigningPublicKey,
        proof: { fingerprint: FINGERPRINT.toLowerCase(), signature },
        capabilities: ['e2ee'],
      },
    };
    expect(() => verifyOfferIdentity(offer, SESSION)).not.toThrow();
  });

  it('reports a malformed SDP fingerprint as MALFORMED_FINGERPRINT', () => {
    // `parseSdpFingerprint` throws a plain `Error`; letting that escape would
    // hand callers `code === undefined` and send them down the wrong branch.
    const offer = offerWith({ sdp: 'v=0\r\na=fingerprint:nonsense\r\n' });
    let code: unknown = 'NO-THROW';
    try {
      verifyOfferIdentity(offer, SESSION);
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(code).toBe('MALFORMED_FINGERPRINT');
  });

  it('refuses a signature over a different session id', () => {
    expect(() => verifyOfferIdentity(offerWith(), 'sess-other')).toThrow(
      /signature/i,
    );
  });

  it('refuses a tampered SDP', () => {
    const offer = offerWith() as never as { data: { sdp: string } };
    offer.data.sdp = SDP.replace('v=0', 'v=1');
    expect(() => verifyOfferIdentity(offer as never, SESSION)).toThrow(
      /signature/i,
    );
  });

  it('distinguishes the mismatch code from the bad-signature code', () => {
    // Callers need to tell them apart: a fingerprint mismatch is a client bug,
    // a bad signature is either a stale key or an attacker. One error message
    // for both sends the user to the wrong fix.
    const mismatch = (() => {
      try {
        verifyOfferIdentity(
          offerWith({
            proof: {
              fingerprint: FINGERPRINT.replace('AB', 'AF'),
              signature: 'AA==',
            },
          }) as never,
          SESSION,
        );
        return 'OK';
      } catch (error) {
        return (error as { code: string }).code;
      }
    })();
    expect(mismatch).toBe('FINGERPRINT_MISMATCH');
  });
});

describe('advertisesE2ee', () => {
  it('is true when the offer proposed e2ee', () => {
    expect(advertisesE2ee(offerWith())).toBe(true);
  });

  it('is false when the offer did not', () => {
    expect(advertisesE2ee(offerWith({ capabilities: [] }))).toBe(false);
  });

  it('does not treat an absent capability list as consent', () => {
    expect(advertisesE2ee(offerWith({ capabilities: undefined }))).toBe(false);
  });
});

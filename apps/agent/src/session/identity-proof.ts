// apps/agent/src/session/identity-proof.ts
import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  canonicalProofMessage,
  normalizeFingerprint,
  parseSdpFingerprint,
  type SignalMessage,
} from '@ponter/shared';
import { decodeBase64Strict } from '../base64.js';

/**
 * The arm of the shared signal union this module validates. Defined by
 * narrowing — `verbatimModuleSyntax` keeps the type import erased, and a change
 * to the shared `offer` shape becomes a `tsc` error here rather than a silent
 * widening. There is no `OfferMessage` in `@ponter/shared` and none in this
 * plan's Task 4 `signalling/messages.ts`; the name is local by design.
 */
export type OfferMessage = Extract<SignalMessage, { type: 'offer' }>;

export type OfferIdentityFailure =
  | 'NO_PROOF'
  | 'NO_SIGNING_KEY'
  | 'MALFORMED_FINGERPRINT'
  | 'FINGERPRINT_MISMATCH'
  | 'BAD_ENCODING'
  | 'BAD_SIGNATURE';

export class OfferIdentityError extends Error {
  constructor(
    readonly code: OfferIdentityFailure,
    message: string,
  ) {
    super(message);
    this.name = 'OfferIdentityError';
  }
}

/**
 * Verifies who sent an offer (B8), in the Rust's five ordered steps.
 *
 * **The agent's own identity is not an input.** `verify_offer_identity` took one
 * and never read it (`_identity`): an agent cannot know a user's key in advance,
 * so the signature is checked against the key the offer carries. The parameter
 * is dropped rather than ported as an unused argument.
 *
 * That the key is carried *in the offer* means this proves **possession of the
 * private key matching the claimed public key**, and that the claim is bound to
 * this SDP and this session. Establishing that the key belongs to the account is
 * WS2's job (`resolvePeerIdentity`, and the TOFU store the web client keeps) —
 * not this function's, and not something to imply by naming.
 *
 * Order matters for the error the caller sees: a malformed SDP fingerprint fails
 * before any signature work, so a client with a broken SDP gets "fingerprint"
 * rather than "signature".
 */
export function verifyOfferIdentity(
  offer: OfferMessage,
  sessionId: string,
): void {
  const data = offer.data as {
    sdp?: string;
    userSigningPublicKey?: string;
    proof?: { fingerprint?: string; signature?: string };
  };
  if (!data.proof) {
    throw new OfferIdentityError('NO_PROOF', 'offer carries no identity proof');
  }
  if (!data.userSigningPublicKey) {
    throw new OfferIdentityError(
      'NO_SIGNING_KEY',
      'offer carries no user signing key',
    );
  }
  if (typeof data.sdp !== 'string') {
    throw new OfferIdentityError(
      'MALFORMED_FINGERPRINT',
      'offer carries no SDP',
    );
  }
  let sdpFingerprint: string;
  try {
    sdpFingerprint = parseSdpFingerprint(data.sdp);
  } catch (error) {
    throw new OfferIdentityError(
      'MALFORMED_FINGERPRINT',
      (error as Error).message,
    );
  }
  const rawProofFingerprint = data.proof.fingerprint;
  if (typeof rawProofFingerprint !== 'string') {
    throw new OfferIdentityError(
      'FINGERPRINT_MISMATCH',
      'the proof fingerprint does not match the SDP fingerprint',
    );
  }
  let proofFingerprint: string;
  try {
    proofFingerprint = normalizeFingerprint(rawProofFingerprint);
  } catch (error) {
    throw new OfferIdentityError(
      'MALFORMED_FINGERPRINT',
      (error as Error).message,
    );
  }
  if (proofFingerprint !== sdpFingerprint) {
    throw new OfferIdentityError(
      'FINGERPRINT_MISMATCH',
      'the proof fingerprint does not match the SDP fingerprint',
    );
  }
  const message = canonicalProofMessage({
    role: 'offerer',
    sessionId,
    sdpSha256Hex: createHash('sha256').update(data.sdp, 'utf8').digest('hex'),
    fingerprint: sdpFingerprint,
  });
  const outcome = verifyMessage(
    data.userSigningPublicKey,
    data.proof.signature ?? '',
    message,
  );
  if (outcome === 'bad-encoding') {
    // **Classification, not corruption.** Measured on this repo's Node 24: a
    // key with `!!!` appended decodes to the *identical* 32 bytes under a
    // lenient `Buffer.from`, so today the offer verifies and a payload the Rust
    // rejects outright is accepted; a key with a substituted character decodes
    // to 32 *different* bytes, so today it fails as a bad signature. Neither is
    // a signature problem — the Rust's `identity::base64_decode` errors before
    // `verify_proof` is ever reached (`identity.rs:150-157`). The two failures
    // send an operator to different places, so they get different codes.
    throw new OfferIdentityError(
      'BAD_ENCODING',
      'the offer identity proof is not valid base64',
    );
  }
  if (outcome === 'bad-signature') {
    throw new OfferIdentityError(
      'BAD_SIGNATURE',
      'the offer identity signature is invalid',
    );
  }
}

/**
 * Ed25519 verify over a base64 **raw 32-byte** public key and a base64 signature.
 *
 * `data.userSigningPublicKey` is the browser's `publicKeyRawBase64`
 * (`apps/web/src/stores/auth.ts:226,296`), relayed verbatim by the server
 * (`apps/server/src/routes/signal.ts:106-117`) and decoded into `[u8; 32]` by the
 * Rust (`apps/agent/src/lib.rs:1250-1258`). It is **not** SPKI DER: an SPKI key is
 * 44 bytes, and `createPublicKey({ format: 'der', type: 'spki' })` over 32 raw
 * bytes throws `Failed to read asymmetric key` — which the `catch` below would
 * turn into `BAD_SIGNATURE`, rejecting every genuine offer.
 *
 * Stays **synchronous** so `verifyOfferIdentity` stays a sync function, matching
 * the Rust (`verify_offer_identity -> Result<()>`, `lib.rs:989`): `createPublicKey`
 * accepts an OKP JWK whose `x` is exactly the raw key in base64url. The 32-byte
 * length check is explicit because a 44-byte SPKI value would otherwise reach the
 * JWK path and fail there with a less legible error.
 *
 * `@ponter/shared` exports the **message builder**, not a verifier — it is
 * platform-neutral and both peers build the string themselves. Verification is
 * `node:crypto`'s, wrapped here because `crypto.verify` throws on a malformed key
 * and a hostile offer is exactly where that would happen. **A throw is a failed
 * signature**, never an escaping exception.
 *
 * Returns *why* it failed, because the two reasons are not the same defect and
 * the caller reports them differently: `'bad-encoding'` is a base64 boundary
 * failure the Rust refuses before any crypto (`identity.rs:150-157`), while
 * `'bad-signature'` is a payload that decoded and did not verify.
 */
function verifyMessage(
  publicKeyRawBase64: string,
  signatureBase64: string,
  message: string,
): 'ok' | 'bad-encoding' | 'bad-signature' {
  const raw = decodeBase64Strict(publicKeyRawBase64);
  const signature = decodeBase64Strict(signatureBase64);
  if (raw === null || signature === null) return 'bad-encoding';
  if (raw.length !== 32) return 'bad-signature';
  try {
    const key = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        // `decodeBase64Strict` hands back a `Uint8Array`; the JWK wants the
        // base64url text, so the Buffer view is re-taken here rather than
        // widening the helper's return type for one caller.
        x: Buffer.from(raw).toString('base64url'),
      },
      format: 'jwk',
    });
    return verify(null, Buffer.from(message, 'utf8'), key, signature)
      ? 'ok'
      : 'bad-signature';
  } catch {
    return 'bad-signature';
  }
}

/**
 * B55: the answer advertises E2EE **iff** the offer proposed it. An offer that
 * omits `capabilities` is not consent — advertising anyway would let a peer that
 * never asked for encryption be told it is getting some.
 */
export function advertisesE2ee(offer: OfferMessage): boolean {
  const capabilities = (offer.data as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities) && capabilities.includes('e2ee');
}

// apps/agent/src/session/identity-proof.ts
import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  canonicalProofMessage,
  normalizeFingerprint,
  parseSdpFingerprint,
  type SignalMessage,
} from '@ponter/shared';

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
  const ok = verifyMessage(
    data.userSigningPublicKey,
    data.proof.signature ?? '',
    message,
  );
  if (!ok) {
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
 */
function verifyMessage(
  publicKeyRawBase64: string,
  signatureBase64: string,
  message: string,
): boolean {
  try {
    const raw = Buffer.from(publicKeyRawBase64, 'base64');
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
    return verify(
      null,
      Buffer.from(message, 'utf8'),
      key,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
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

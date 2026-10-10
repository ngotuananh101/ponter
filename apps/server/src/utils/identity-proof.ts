import { webcrypto } from 'node:crypto';

/**
 * The canonical WS2 user-identity proof, mirrored locally.
 *
 * Deliberately a local mirror of `canonicalUserIdentityMessage` in
 * `@ponter/shared` rather than an import: the shared package ships TypeScript
 * source, and the production image runs `node apps/server/dist/index.js` — a
 * runtime import of it would fail at startup with ERR_MODULE_NOT_FOUND. This is
 * the same reasoning as `normalizeBrowserFrame` in `routes/ws.ts`.
 *
 * The bytes produced here MUST stay identical to the shared implementation:
 * the browser signs this exact string and the server verifies it, so any drift
 * would silently break legacy-account signing-key bootstrap. The drift guard in
 * `test/identity-proof-mirror.test.ts` pins the two against each other.
 */

/**
 * The exact UTF-8 string a browser signs to prove ownership of `userId`.
 * Single `\n` separator, no trailing newline.
 *
 * Mirror of `canonicalUserIdentityMessage` in `@ponter/shared`.
 */
export function canonicalUserIdentityMessage(userId: string): string {
  return `ponter-ws2-user-identity-v1\nuserId=${userId}`;
}

/**
 * Verify that `signature` is a valid Ed25519 signature over
 * `canonicalUserIdentityMessage(userId)` produced by `signingPublicKey`.
 *
 * Fail closed: any import/verify error, malformed base64, or false signature
 * returns false.
 */
export async function verifyUserIdentityProof(
  userId: string,
  signingPublicKeyBase64: string,
  signatureBase64: string,
): Promise<boolean> {
  const message = canonicalUserIdentityMessage(userId);
  try {
    const key = await webcrypto.subtle.importKey(
      'raw',
      Buffer.from(signingPublicKeyBase64, 'base64'),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await webcrypto.subtle.verify(
      'Ed25519',
      key,
      Buffer.from(signatureBase64, 'base64'),
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

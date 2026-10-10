/**
 * Shared test helpers for signing-key bootstrap and reset integration tests.
 *
 * Extracted to eliminate Sonar CPD duplication between
 * `signing-key-bootstrap.test.ts` and `signing-key-reset.test.ts`.
 */
import { expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { createApp } from '../../src/app';

// In-process secrets for tests, matching the auth test harness.
export const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
export const REFRESH_TOKEN_SECRET =
  'test-refresh-secret-at-least-32-characters';

export type ErrorResponse = {
  error: string;
  code: string;
  details: unknown;
};

/** Generate an Ed25519 keypair and return base64-encoded public key + signer. */
export async function keypair() {
  const kp = await webcrypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]);
  const raw = await webcrypto.subtle.exportKey('raw', kp.publicKey);
  return {
    kp,
    publicKeyB64: Buffer.from(raw).toString('base64'),
  };
}

/** Sign `msg` with the private key, return base64 signature. */
export async function sign(
  kp: webcrypto.CryptoKeyPair,
  msg: string,
): Promise<string> {
  return Buffer.from(
    await webcrypto.subtle.sign(
      'Ed25519',
      kp.privateKey,
      new TextEncoder().encode(msg),
    ),
  ).toString('base64');
}

/** Register a user (legacy — no signing key) and return credentials + userId. */
export async function registerLegacyUser(app: ReturnType<typeof createApp>) {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'legacy_user',
      password: 'Password123!',
      publicKey: 'pk_legacy',
      // No signingPublicKey — simulates a pre-PR-#44 legacy account.
    }),
  });

  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    user: { id: string; signingPublicKey: string | null };
    token: string;
  };
  expect(body.user.signingPublicKey).toBeNull();
  return { userId: body.user.id, token: body.token };
}

/** Bootstrap a signing key for a legacy user and return the keypair + public key base64. */
export async function bootstrapSigningKey(
  app: ReturnType<typeof createApp>,
  userId: string,
  token: string,
  canonicalMessage: string,
) {
  const { kp, publicKeyB64 } = await keypair();
  const sig = await sign(kp, canonicalMessage);
  const res = await app.request('/api/auth/signing-key', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ signingPublicKey: publicKeyB64, signature: sig }),
  });
  expect(res.status).toBe(200);
  return { kp, publicKeyB64 };
}

/** Fetch the current user's signingPublicKey via /api/users/me. */
export async function fetchMeSigningKey(
  app: ReturnType<typeof createApp>,
  token: string,
): Promise<string | null> {
  const meRes = await app.request('/api/users/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const me = (await meRes.json()) as {
    user: { signingPublicKey: string | null };
  };
  return me.user.signingPublicKey;
}

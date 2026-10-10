import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';
import { canonicalUserIdentityMessage } from '../src/utils/identity-proof';

// In-process secrets for tests, matching the auth test harness.
const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

process.env.JWT_SECRET = JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = REFRESH_TOKEN_SECRET;
process.env.E2E_AUTO_APPROVE_USERS = 'true';

type ErrorResponse = {
  error: string;
  code: string;
  details: unknown;
};

/** Register a user (legacy — no signing key) and return credentials + userId. */
async function registerLegacyUser(app: ReturnType<typeof createApp>) {
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

/** Generate an Ed25519 keypair and return base64-encoded public key + signer. */
async function keypair() {
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
async function sign(kp: webcrypto.CryptoKeyPair, msg: string): Promise<string> {
  return Buffer.from(
    await webcrypto.subtle.sign(
      'Ed25519',
      kp.privateKey,
      new TextEncoder().encode(msg),
    ),
  ).toString('base64');
}

describe('POST /api/auth/signing-key/reset', () => {
  beforeEach(() => {
    closeDb();
    getDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('Case 1: wrong password -> 401 INVALID_CREDENTIALS', async () => {
    const app = createApp();
    const { userId, token } = await registerLegacyUser(app);

    // First bootstrap a signing key so the user has one.
    const { kp: kp1, publicKeyB64: pub1 } = await keypair();
    const sig1 = await sign(kp1, canonicalUserIdentityMessage(userId));
    await app.request('/api/auth/signing-key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ signingPublicKey: pub1, signature: sig1 }),
    });

    // Now attempt reset with WRONG password but valid signature/key.
    const { kp: kp2, publicKeyB64: pub2 } = await keypair();
    const sig2 = await sign(kp2, canonicalUserIdentityMessage(userId));
    const res = await app.request('/api/auth/signing-key/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        password: 'WrongPassword123!',
        signingPublicKey: pub2,
        signature: sig2,
      }),
    });

    expect(res.status).toBe(401);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('INVALID_CREDENTIALS');

    // The original signing key must be unchanged.
    const meRes = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me = (await meRes.json()) as {
      user: { signingPublicKey: string | null };
    };
    expect(me.user.signingPublicKey).toBe(pub1);
  });

  it('Case 2: invalid signature -> 400 VALIDATION_ERROR', async () => {
    const app = createApp();
    const { userId, token } = await registerLegacyUser(app);

    // Bootstrap a signing key first.
    const { kp, publicKeyB64: pub1 } = await keypair();
    const sig1 = await sign(kp, canonicalUserIdentityMessage(userId));
    await app.request('/api/auth/signing-key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ signingPublicKey: pub1, signature: sig1 }),
    });

    // Attempt reset with valid password but INVALID signature (signs wrong message).
    const { kp: kp2, publicKeyB64: pub2 } = await keypair();
    const badSig = await sign(
      kp2,
      canonicalUserIdentityMessage('some-other-id'),
    );
    const res = await app.request('/api/auth/signing-key/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        password: 'Password123!',
        signingPublicKey: pub2,
        signature: badSig,
      }),
    });

    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('VALIDATION_ERROR');

    // The original signing key must be unchanged.
    const meRes = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me = (await meRes.json()) as {
      user: { signingPublicKey: string | null };
    };
    expect(me.user.signingPublicKey).toBe(pub1);
  });

  it('Case 3: success re-key when user already had a signing key -> 200 + updated DB + /me reflects new key', async () => {
    const app = createApp();
    const { userId, token } = await registerLegacyUser(app);

    // Bootstrap an initial signing key.
    const { kp: kp1, publicKeyB64: pub1 } = await keypair();
    const sig1 = await sign(kp1, canonicalUserIdentityMessage(userId));
    await app.request('/api/auth/signing-key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ signingPublicKey: pub1, signature: sig1 }),
    });

    // Now reset to a new signing key with valid password + valid signature.
    const { kp: kp2, publicKeyB64: pub2 } = await keypair();
    const sig2 = await sign(kp2, canonicalUserIdentityMessage(userId));
    const res = await app.request('/api/auth/signing-key/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        password: 'Password123!',
        signingPublicKey: pub2,
        signature: sig2,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { signingPublicKey: string | null };
    };
    expect(body.user.signingPublicKey).toBe(pub2);

    // /api/users/me must reflect the new key.
    const meRes = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as {
      user: { signingPublicKey: string | null };
    };
    expect(me.user.signingPublicKey).toBe(pub2);
  });

  it('Case 4: missing / empty fields -> 400 VALIDATION_ERROR', async () => {
    const app = createApp();
    const { userId, token } = await registerLegacyUser(app);

    // Bootstrap a signing key so the user has one.
    const { kp, publicKeyB64: pub1 } = await keypair();
    const sig1 = await sign(kp, canonicalUserIdentityMessage(userId));
    await app.request('/api/auth/signing-key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ signingPublicKey: pub1, signature: sig1 }),
    });

    const { kp: kp2, publicKeyB64: pub2 } = await keypair();
    const sig2 = await sign(kp2, canonicalUserIdentityMessage(userId));

    const cases = [
      // 1. missing signature
      {
        name: 'missing signature',
        body: { password: 'Password123!', signingPublicKey: pub2 },
      },
      // 2. missing signingPublicKey
      {
        name: 'missing signingPublicKey',
        body: { password: 'Password123!', signature: sig2 },
      },
      // 3. missing password
      {
        name: 'missing password',
        body: { signingPublicKey: pub2, signature: sig2 },
      },
      // 4. empty-string password
      {
        name: 'empty password',
        body: { password: '   ', signingPublicKey: pub2, signature: sig2 },
      },
      // 5. empty-string signingPublicKey
      {
        name: 'empty signingPublicKey',
        body: {
          password: 'Password123!',
          signingPublicKey: '   ',
          signature: sig2,
        },
      },
      // 6. empty-string signature
      {
        name: 'empty signature',
        body: {
          password: 'Password123!',
          signingPublicKey: pub2,
          signature: '   ',
        },
      },
      // 7. non-string password (number)
      {
        name: 'non-string password',
        body: { password: 123, signingPublicKey: pub2, signature: sig2 },
      },
    ];

    for (const tc of cases) {
      const res = await app.request('/api/auth/signing-key/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(tc.body),
      });

      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrorResponse;
      expect(err.code).toBe('VALIDATION_ERROR');
    }

    // The original signing key must be unchanged after all bad attempts.
    const meRes = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me = (await meRes.json()) as {
      user: { signingPublicKey: string | null };
    };
    expect(me.user.signingPublicKey).toBe(pub1);
  });

  it('Case 5: unauthenticated call (no Bearer token) -> 401', async () => {
    const app = createApp();

    const { kp, publicKeyB64 } = await keypair();
    const sig = await sign(kp, canonicalUserIdentityMessage('no-auth-test'));

    const res = await app.request('/api/auth/signing-key/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: 'Password123!',
        signingPublicKey: publicKeyB64,
        signature: sig,
      }),
    });

    expect(res.status).toBe(401);
  });
});

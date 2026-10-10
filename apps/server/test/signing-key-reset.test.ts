import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';
import { canonicalUserIdentityMessage } from '../src/utils/identity-proof';
import {
  JWT_SECRET,
  REFRESH_TOKEN_SECRET,
  type ErrorResponse,
  keypair,
  sign,
  registerLegacyUser,
  bootstrapSigningKey,
  fetchMeSigningKey,
} from './helpers/signing-key-helpers';

process.env.JWT_SECRET = JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = REFRESH_TOKEN_SECRET;
process.env.E2E_AUTO_APPROVE_USERS = 'true';

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
    const { publicKeyB64: pub1 } = await bootstrapSigningKey(
      app,
      userId,
      token,
      canonicalUserIdentityMessage(userId),
    );

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
    expect(await fetchMeSigningKey(app, token)).toBe(pub1);
  });

  it('Case 2: invalid signature -> 400 VALIDATION_ERROR', async () => {
    const app = createApp();
    const { userId, token } = await registerLegacyUser(app);
    const { publicKeyB64: pub1 } = await bootstrapSigningKey(
      app,
      userId,
      token,
      canonicalUserIdentityMessage(userId),
    );

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
    expect(await fetchMeSigningKey(app, token)).toBe(pub1);
  });

  it('Case 3: success re-key when user already had a signing key -> 200 + updated DB + /me reflects new key', async () => {
    const app = createApp();
    const { userId, token } = await registerLegacyUser(app);
    await bootstrapSigningKey(
      app,
      userId,
      token,
      canonicalUserIdentityMessage(userId),
    );

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
    expect(await fetchMeSigningKey(app, token)).toBe(pub2);
  });

  it('Case 4: missing / empty fields -> 400 VALIDATION_ERROR', async () => {
    const app = createApp();
    const { userId, token } = await registerLegacyUser(app);
    const { publicKeyB64: pub1 } = await bootstrapSigningKey(
      app,
      userId,
      token,
      canonicalUserIdentityMessage(userId),
    );

    const { kp: kp2, publicKeyB64: pub2 } = await keypair();
    const sig2 = await sign(kp2, canonicalUserIdentityMessage(userId));

    const cases = [
      {
        name: 'missing signature',
        body: { password: 'Password123!', signingPublicKey: pub2 },
      },
      {
        name: 'missing signingPublicKey',
        body: { password: 'Password123!', signature: sig2 },
      },
      {
        name: 'missing password',
        body: { signingPublicKey: pub2, signature: sig2 },
      },
      {
        name: 'empty password',
        body: { password: '   ', signingPublicKey: pub2, signature: sig2 },
      },
      {
        name: 'empty signingPublicKey',
        body: {
          password: 'Password123!',
          signingPublicKey: '   ',
          signature: sig2,
        },
      },
      {
        name: 'empty signature',
        body: {
          password: 'Password123!',
          signingPublicKey: pub2,
          signature: '   ',
        },
      },
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
    expect(await fetchMeSigningKey(app, token)).toBe(pub1);
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

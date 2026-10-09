import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';
import { canonicalUserIdentityMessage } from '@ponter/shared';

// In-process secrets for tests, matching the auth test harness.
const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

process.env.JWT_SECRET = JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = REFRESH_TOKEN_SECRET;
process.env.E2E_AUTO_APPROVE_USERS = 'true';

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

async function sign(kp: webcrypto.CryptoKeyPair, msg: string): Promise<string> {
  return Buffer.from(
    await webcrypto.subtle.sign(
      'Ed25519',
      kp.privateKey,
      new TextEncoder().encode(msg),
    ),
  ).toString('base64');
}

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

type ErrorResponse = {
  error: string;
  code: string;
  details: unknown;
};

describe('POST /api/auth/signing-key (legacy bootstrap)', () => {
  beforeEach(() => {
    closeDb();
    getDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('valid proof → 200 + persisted + /api/users/me reflects it', async () => {
    const app = createApp();
    const { userId, token } = await registerLegacyUser(app);
    const { kp, publicKeyB64 } = await keypair();
    const signature = await sign(kp, canonicalUserIdentityMessage(userId));

    const res = await app.request('/api/auth/signing-key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ signingPublicKey: publicKeyB64, signature }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { signingPublicKey: string | null };
    };
    expect(body.user.signingPublicKey).toBe(publicKeyB64);

    // /api/users/me must also reflect the persisted key.
    const meRes = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as {
      user: { signingPublicKey: string | null };
    };
    expect(me.user.signingPublicKey).toBe(publicKeyB64);
  });

  it('bootstrap is one-shot: second call → 409, first key unchanged', async () => {
    const app = createApp();
    const { userId, token } = await registerLegacyUser(app);
    const { kp, publicKeyB64 } = await keypair();
    const signature = await sign(kp, canonicalUserIdentityMessage(userId));

    const first = await app.request('/api/auth/signing-key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ signingPublicKey: publicKeyB64, signature }),
    });
    expect(first.status).toBe(200);

    const second = await app.request('/api/auth/signing-key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ signingPublicKey: publicKeyB64, signature }),
    });
    expect(second.status).toBe(409);
    const err = (await second.json()) as ErrorResponse;
    expect(err.code).toBe('SIGNING_KEY_ALREADY_SET');

    // /api/users/me still shows the FIRST key.
    const meRes = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me = (await meRes.json()) as {
      user: { signingPublicKey: string | null };
    };
    expect(me.user.signingPublicKey).toBe(publicKeyB64);
  });

  it('signature over a different userId → 400, not stored', async () => {
    const app = createApp();
    const { token } = await registerLegacyUser(app);
    const { kp, publicKeyB64 } = await keypair();
    const signature = await sign(
      kp,
      canonicalUserIdentityMessage('some-other-id'),
    );

    const res = await app.request('/api/auth/signing-key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ signingPublicKey: publicKeyB64, signature }),
    });

    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('VALIDATION_ERROR');

    const meRes = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me = (await meRes.json()) as {
      user: { signingPublicKey: string | null };
    };
    expect(me.user.signingPublicKey).toBeNull();
  });

  it('bad / empty / malformed input → 400, not stored', async () => {
    const app = createApp();
    const { userId, token } = await registerLegacyUser(app);
    const { kp, publicKeyB64 } = await keypair();
    const signature = await sign(kp, canonicalUserIdentityMessage(userId));

    // A signature that is valid base64 but verifies false (all-zero bytes).
    const falseSignature = 'AAAAAAAAAAAAAAAAAAAAAA==';

    const cases = [
      // 1. valid base64 signature that verifies false
      {
        name: 'false signature',
        body: { signingPublicKey: publicKeyB64, signature: falseSignature },
      },
      // 2. missing signature field
      {
        name: 'missing signature',
        body: { signingPublicKey: publicKeyB64 },
      },
      // 3. missing signingPublicKey field
      {
        name: 'missing signingPublicKey',
        body: { signature },
      },
      // 4. empty-string signingPublicKey
      {
        name: 'empty signingPublicKey',
        body: { signingPublicKey: '   ', signature },
      },
      // 5. malformed base64 signingPublicKey (import throws → 400)
      {
        name: 'malformed base64 signingPublicKey',
        body: { signingPublicKey: 'not!!!valid!!!base64!!!', signature },
      },
    ];

    for (const tc of cases) {
      const res = await app.request('/api/auth/signing-key', {
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

    // After all bad attempts, signingPublicKey is still null.
    const meRes = await app.request('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const me = (await meRes.json()) as {
      user: { signingPublicKey: string | null };
    };
    expect(me.user.signingPublicKey).toBeNull();
  });

  it('no auth token → 401', async () => {
    const app = createApp();
    const { kp, publicKeyB64 } = await keypair();
    const signature = await sign(
      kp,
      canonicalUserIdentityMessage('no-auth-test'),
    );

    const res = await app.request('/api/auth/signing-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signingPublicKey: publicKeyB64, signature }),
    });

    expect(res.status).toBe(401);
  });
});

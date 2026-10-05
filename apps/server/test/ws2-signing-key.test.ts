import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app';
import { closeDb } from '../src/db/client';

// In-process secrets for tests, matching the auth test harness.
const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

process.env.JWT_SECRET = JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = REFRESH_TOKEN_SECRET;

const app = createApp();
const SIGNING = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='; // 32 bytes base64

async function register(username: string, signingPublicKey?: string) {
  return app.fetch(
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password: 'password123',
        publicKey: 'ecdh-pk',
        ...(signingPublicKey ? { signingPublicKey } : {}),
      }),
    }),
  );
}

describe('WS2 user signing key', () => {
  beforeEach(() => closeDb());

  it('stores the signing public key and returns it on the public user', async () => {
    const res = await register('ws2_user_a', SIGNING);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { signingPublicKey: string | null };
    };
    expect(body.user.signingPublicKey).toBe(SIGNING);
  });

  it('accepts registration without a signing key (legacy shape)', async () => {
    const res = await register('ws2_user_b');
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { signingPublicKey: string | null };
    };
    expect(body.user.signingPublicKey).toBeNull();
  });
});

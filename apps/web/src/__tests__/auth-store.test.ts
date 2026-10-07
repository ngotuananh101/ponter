import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '@/stores/auth';
import { apiClient } from '@/services/client';
import { tokenStorage } from '@/services/token-storage';
import * as cryptoPkg from '@ponter/crypto';
import type { User } from '@ponter/shared';

vi.mock('@ponter/crypto', async (importOriginal) => ({
  ...(await importOriginal()),
  generateUserKeyPair: vi.fn(),
  savePrivateKey: vi.fn(),
  deletePrivateKey: vi.fn(),
  generateSigningKeyPair: vi.fn(),
  saveSigningKey: vi.fn(),
  loadSigningKey: vi.fn(),
}));

describe('Auth Store (Pinia)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    tokenStorage.clearTokens();
    vi.restoreAllMocks();
  });

  it('1. login with valid credentials sets user and status: authenticated', async () => {
    const store = useAuthStore();
    vi.spyOn(apiClient.auth, 'login').mockResolvedValue({
      user: { id: 'u1', username: 'alice' } as unknown as User,
      token: 'access-tok',
      refreshToken: 'ref-tok',
      expiresIn: 900,
    });

    await store.login('alice', 'password123');
    expect(store.user?.username).toBe('alice');
    expect(store.isAuthenticated).toBe(true);
    expect(store.status).toBe('authenticated');
  });

  it('2. login failure sets error and leaves status: error', async () => {
    const store = useAuthStore();
    vi.spyOn(apiClient.auth, 'login').mockRejectedValue(
      new Error('Invalid credentials'),
    );

    await expect(store.login('alice', 'badpass')).rejects.toThrow();
    expect(store.isAuthenticated).toBe(false);
    expect(store.status).toBe('error');
    expect(store.error).toBe('Invalid credentials');
  });

  it('3. register calls generateUserKeyPair and passes publicKeySpkiBase64 to the API', async () => {
    const store = useAuthStore();
    const dummyKey = {} as CryptoKey;
    const signPair = {
      publicKeyRawBase64: 'signing-pub',
      privateKey: {} as CryptoKey,
      publicKey: {} as CryptoKey,
    };
    vi.mocked(cryptoPkg.generateUserKeyPair).mockResolvedValue({
      publicKeySpkiBase64: 'MFkwEwYHKoZIzj0CAQYIKoZ...',
      privateKey: dummyKey,
      publicKey: dummyKey,
    });
    vi.mocked(cryptoPkg.generateSigningKeyPair).mockResolvedValue(signPair);

    const regSpy = vi.spyOn(apiClient.auth, 'register').mockResolvedValue({
      user: { id: 'u-reg-1', username: 'bob' } as unknown as User,
      token: 'tok',
      refreshToken: 'ref',
      expiresIn: 900,
    });

    const savePrivSpy = vi.mocked(cryptoPkg.savePrivateKey).mockResolvedValue();
    const saveSignSpy = vi.mocked(cryptoPkg.saveSigningKey).mockResolvedValue();

    await store.register({
      username: 'bob',
      password: 'password123',
    });

    expect(regSpy).toHaveBeenCalledTimes(1);
    const payload = regSpy.mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    // The exact key set is load-bearing: an extra `privateKey` field must fail here.
    expect(Object.keys(payload).sort()).toEqual([
      'email',
      'password',
      'publicKey',
      'signingPublicKey',
      'username',
    ]);
    expect(payload).toEqual({
      username: 'bob',
      email: undefined,
      password: 'password123',
      publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZ...',
      signingPublicKey: 'signing-pub',
    });
    expect(savePrivSpy).toHaveBeenCalledWith('u-reg-1', dummyKey);
    expect(saveSignSpy).toHaveBeenCalledWith('u-reg-1', signPair.privateKey);
    expect(store.user?.id).toBe('u-reg-1');
  });

  it('4. register persists the private key with the returned user ID', async () => {
    const store = useAuthStore();
    const mockPrivKey = { type: 'private' } as CryptoKey;
    vi.mocked(cryptoPkg.generateUserKeyPair).mockResolvedValue({
      publicKeySpkiBase64: 'spki-key',
      privateKey: mockPrivKey,
      publicKey: {} as CryptoKey,
    });
    vi.spyOn(apiClient.auth, 'register').mockResolvedValue({
      user: { id: 'user-id-99', username: 'charlie' } as unknown as User,
      token: 't',
      refreshToken: 'r',
      expiresIn: 900,
    });
    const saveSpy = vi.mocked(cryptoPkg.savePrivateKey).mockResolvedValue();

    await store.register({ username: 'charlie', password: 'password123' });
    expect(saveSpy).toHaveBeenCalledWith('user-id-99', mockPrivKey);
  });

  it('5. logout calls API, clears tokens, and resets state but keeps the private key', async () => {
    const store = useAuthStore();
    store.user = { id: 'user-to-logout', username: 'dave' } as unknown as User;
    store.status = 'authenticated';
    tokenStorage.setTokens({ accessToken: 'a', refreshToken: 'r' });

    const logoutSpy = vi
      .spyOn(apiClient.auth, 'logout')
      .mockResolvedValue({ success: true });

    await store.logout();

    expect(cryptoPkg.deletePrivateKey).not.toHaveBeenCalled();
    expect(logoutSpy).toHaveBeenCalledWith('r');
    expect(store.user).toBeNull();
    expect(store.status).toBe('idle');
    expect(await tokenStorage.getAccessToken()).toBeNull();
  });

  it('6. restore() with no stored token leaves store idle and does not call API', async () => {
    const store = useAuthStore();
    const meSpy = vi.spyOn(apiClient.users, 'me');

    await store.restore();

    expect(meSpy).not.toHaveBeenCalled();
    expect(store.status).toBe('idle');
    expect(store.restored).toBe(true);
  });

  it('7. restore() with a stored token calls fetchMe and sets authenticated', async () => {
    const store = useAuthStore();
    tokenStorage.setTokens({
      accessToken: 'valid-token',
      refreshToken: 'valid-ref',
    });
    vi.spyOn(apiClient.users, 'me').mockResolvedValue({
      user: { id: 'u1', username: 'eve' } as unknown as User,
    });

    await store.restore();

    expect(store.user?.username).toBe('eve');
    expect(store.status).toBe('authenticated');
    expect(store.restored).toBe(true);
  });

  it('8. restore() with an invalid stored token clears tokens and returns to idle', async () => {
    const store = useAuthStore();
    tokenStorage.setTokens({
      accessToken: 'expired-token',
      refreshToken: 'bad-ref',
    });
    vi.spyOn(apiClient.users, 'me').mockRejectedValue(
      new Error('Unauthorized'),
    );

    await store.restore();

    expect(store.user).toBeNull();
    expect(store.status).toBe('idle');
    expect(await tokenStorage.getAccessToken()).toBeNull();
  });

  it('9. register with 409/403 rejection leaves requiresApproval false and sets error', async () => {
    const store = useAuthStore();
    vi.mocked(cryptoPkg.generateUserKeyPair).mockResolvedValue({
      publicKeySpkiBase64: 'pk',
      privateKey: {} as CryptoKey,
      publicKey: {} as CryptoKey,
    });

    vi.spyOn(apiClient.auth, 'register').mockRejectedValue(
      new Error('Username already taken'),
    );

    await expect(
      store.register({ username: 'dup', password: 'password123' }),
    ).rejects.toThrow('Username already taken');

    expect(store.requiresApproval).toBe(false);
    expect(store.error).toBe('Username already taken');
    expect(store.user).toBeNull();
  });

  it('10. register with requiresApproval persists the local identity keys for the pending user', async () => {
    const store = useAuthStore();
    const ecdhPrivKey = { type: 'ecdh-private' } as unknown as CryptoKey;
    const signPrivKey = { type: 'ed25519-private' } as unknown as CryptoKey;
    vi.mocked(cryptoPkg.generateUserKeyPair).mockResolvedValue({
      publicKeySpkiBase64: 'pk',
      privateKey: ecdhPrivKey,
      publicKey: {} as CryptoKey,
    });
    vi.mocked(cryptoPkg.generateSigningKeyPair).mockResolvedValue({
      publicKeyRawBase64: 'signing-pub',
      privateKey: signPrivKey,
      publicKey: {} as CryptoKey,
    });

    vi.spyOn(apiClient.auth, 'register').mockResolvedValue({
      user: { id: 'u-pending', username: 'newuser' } as unknown as User,
      requiresApproval: true,
      message:
        'Registration successful. Your account is pending administrator approval.',
    });

    const savePrivSpy = vi.mocked(cryptoPkg.savePrivateKey).mockResolvedValue();
    const saveSignSpy = vi.mocked(cryptoPkg.saveSigningKey).mockResolvedValue();

    await store.register({ username: 'newuser', password: 'password123' });

    expect(store.requiresApproval).toBe(true);
    expect(store.error).toBeNull();
    expect(store.user).toBeNull();
    expect(store.status).toBe('idle');
    // The private halves exist only locally, and the server already recorded the
    // matching public key at registration time. Dropping them here would leave
    // the pending account unable to produce an identity proof after approval —
    // and ADR-41 makes that proof a fail-closed admission gate for every session
    // mode, so the account could never connect.
    expect(savePrivSpy).toHaveBeenCalledWith('u-pending', ecdhPrivKey);
    expect(saveSignSpy).toHaveBeenCalledWith('u-pending', signPrivKey);
  });
});

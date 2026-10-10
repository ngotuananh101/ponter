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
  savePublicKey: vi.fn(),
  deletePrivateKey: vi.fn(),
  generateSigningKeyPair: vi.fn(),
  saveSigningKey: vi.fn(),
  saveSigningPublicKey: vi.fn(),
  loadSigningKey: vi.fn(),
  loadSigningPublicKey: vi.fn(),
  signProof: vi.fn(),
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

/**
 * Legacy-account signing-key bootstrap (PM refinement, 5 cells).
 *
 * `ensureUserSigningKey` is best-effort (never throws). These tests cover the
 * full state matrix and the 5 cells:
 * 1. local PRIVATE absent + server NULL → generate + save private + save PUBLIC RAW + POST.
 * 2. local PRIVATE present + server NULL + stored PUB present → POST existing key (no generation).
 * 3. local PRIVATE present + server NULL + stored PUB absent → unrecoverable, no POST, no generation.
 * 4. local PRIVATE absent + server PRESENT → unrecoverable (second device), no POST.
 * 5. both present → no-op (no POST, no generation).
 */
describe('Auth Store — ensureUserSigningKey bootstrap matrix', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    tokenStorage.clearTokens();
    vi.clearAllMocks();
  });

  const makeUser = (signingPublicKey: string | null): User =>
    ({ id: 'user-bootstrap', signingPublicKey }) as unknown as User;

  /**
   * Shared mock setup for the fresh-key scenarios (cell 1 and the 409 test):
   * local private absent + server NULL + generateSigningKeyPair + signProof.
   * Returns the signPair and the registerSigningKey spy so each test can
   * assert its distinct outcome.
   */
  function setupFreshKeyScenario(store: ReturnType<typeof useAuthStore>): {
    signPair: {
      publicKeyRawBase64: string;
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    registerSpy: ReturnType<typeof vi.spyOn>;
  } {
    store.user = makeUser(null);
    vi.mocked(cryptoPkg.loadSigningKey).mockResolvedValue(null);
    vi.mocked(cryptoPkg.loadSigningPublicKey).mockResolvedValue(null);
    const signPair = {
      publicKeyRawBase64: 'new-pub-raw',
      privateKey: {} as CryptoKey,
      publicKey: {} as CryptoKey,
    };
    vi.mocked(cryptoPkg.generateSigningKeyPair).mockResolvedValue(signPair);
    vi.mocked(cryptoPkg.signProof).mockResolvedValue('sig');
    const registerSpy = vi
      .spyOn(apiClient.auth, 'registerSigningKey')
      .mockResolvedValue({ user: makeUser('new-pub-raw') });
    return { signPair, registerSpy };
  }

  it('cell 1: local private absent + server NULL → generates, saves both keys, POSTs the new public raw', async () => {
    const store = useAuthStore();
    const { signPair, registerSpy } = setupFreshKeyScenario(store);

    await store.ensureUserSigningKey(makeUser(null));

    expect(cryptoPkg.generateSigningKeyPair).toHaveBeenCalledTimes(1);
    expect(cryptoPkg.saveSigningKey).toHaveBeenCalledWith(
      'user-bootstrap',
      signPair.privateKey,
    );
    expect(cryptoPkg.saveSigningPublicKey).toHaveBeenCalledWith(
      'user-bootstrap',
      'new-pub-raw',
    );
    expect(cryptoPkg.signProof).toHaveBeenCalled();
    expect(registerSpy).toHaveBeenCalledWith({
      signingPublicKey: 'new-pub-raw',
      signature: 'sig',
    });
    expect(store.identityStatus).toBe('ready');
  });

  it('cell 2: local private present + server NULL + stored PUB present → POSTs the existing key, no generation', async () => {
    const store = useAuthStore();
    store.user = makeUser(null);

    const localPrivate = {} as CryptoKey;
    vi.mocked(cryptoPkg.loadSigningKey).mockResolvedValue(localPrivate);
    vi.mocked(cryptoPkg.loadSigningPublicKey).mockResolvedValue(
      'stored-pub-raw',
    );
    vi.mocked(cryptoPkg.signProof).mockResolvedValue('existing-sig');
    const registerSpy = vi
      .spyOn(apiClient.auth, 'registerSigningKey')
      .mockResolvedValue({ user: makeUser('stored-pub-raw') });

    await store.ensureUserSigningKey(makeUser(null));

    expect(cryptoPkg.generateSigningKeyPair).not.toHaveBeenCalled();
    expect(cryptoPkg.saveSigningKey).not.toHaveBeenCalled();
    expect(cryptoPkg.saveSigningPublicKey).not.toHaveBeenCalled();
    expect(cryptoPkg.signProof).toHaveBeenCalledWith(
      localPrivate,
      expect.stringContaining('user-bootstrap'),
    );
    expect(registerSpy).toHaveBeenCalledWith({
      signingPublicKey: 'stored-pub-raw',
      signature: 'existing-sig',
    });
    expect(store.identityStatus).toBe('ready');
  });

  it('cell 3: local private present + server NULL + stored PUB absent → unrecoverable, no POST, no generation', async () => {
    const store = useAuthStore();
    store.user = makeUser(null);

    vi.mocked(cryptoPkg.loadSigningKey).mockResolvedValue({} as CryptoKey);
    vi.mocked(cryptoPkg.loadSigningPublicKey).mockResolvedValue(null);
    const registerSpy = vi.spyOn(apiClient.auth, 'registerSigningKey');

    await store.ensureUserSigningKey(makeUser(null));

    expect(cryptoPkg.generateSigningKeyPair).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
    expect(store.identityStatus).toBe('unavailable');
  });

  it('cell 4: local private absent + server PRESENT → unrecoverable (second device), no POST', async () => {
    const store = useAuthStore();
    store.user = makeUser('server-has-key');

    vi.mocked(cryptoPkg.loadSigningKey).mockResolvedValue(null);
    vi.mocked(cryptoPkg.loadSigningPublicKey).mockResolvedValue(null);
    const registerSpy = vi.spyOn(apiClient.auth, 'registerSigningKey');

    await store.ensureUserSigningKey(makeUser('server-has-key'));

    expect(cryptoPkg.generateSigningKeyPair).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
    expect(store.identityStatus).toBe('unavailable');
  });

  it('cell 5: both present → no POST, no generation', async () => {
    const store = useAuthStore();
    store.user = makeUser('server-key');

    vi.mocked(cryptoPkg.loadSigningKey).mockResolvedValue({} as CryptoKey);
    const registerSpy = vi.spyOn(apiClient.auth, 'registerSigningKey');

    await store.ensureUserSigningKey(makeUser('server-key'));

    expect(cryptoPkg.generateSigningKeyPair).not.toHaveBeenCalled();
    expect(cryptoPkg.signProof).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
    expect(store.identityStatus).toBe('ready');
  });

  it('409 on POST leaves identity unavailable (server key already set) and never throws', async () => {
    const store = useAuthStore();
    setupFreshKeyScenario(store);

    // The 409 path: registerSigningKey throws, but ensureUserSigningKey must not
    // rethrow. A 409 means the server already has a key — because the key we
    // are registering is freshly generated (or stored) and cannot be assumed
    // to match the server's, identityStatus stays 'unavailable' honestly.
    const { ApiError } = await import('@ponter/api-client');
    vi.spyOn(apiClient.auth, 'registerSigningKey').mockRejectedValue(
      new ApiError('already set', 409, 'SIGNING_KEY_ALREADY_SET'),
    );

    await store.ensureUserSigningKey(makeUser(null));

    // On 409 the user is already bootstrapped server-side; identityStatus must
    // not be left stuck on the default — but since we can't fetch the refreshed
    // user here (POST failed), we accept 'unavailable' as honest state and rely
    // on the next login/restore to refresh. The key contract: never throws.
    expect(store.identityStatus).toBe('unavailable');
  });

  it('register persists the public raw alongside the private signing key', async () => {
    const store = useAuthStore();
    const dummyKey = {} as CryptoKey;
    const signPair = {
      publicKeyRawBase64: 'signing-pub',
      privateKey: {} as CryptoKey,
      publicKey: {} as CryptoKey,
    };
    vi.mocked(cryptoPkg.generateUserKeyPair).mockResolvedValue({
      publicKeySpkiBase64: 'spki',
      privateKey: dummyKey,
      publicKey: dummyKey,
    });
    vi.mocked(cryptoPkg.generateSigningKeyPair).mockResolvedValue(signPair);
    vi.spyOn(apiClient.auth, 'register').mockResolvedValue({
      user: {
        id: 'u-reg-1',
        signingPublicKey: 'signing-pub',
      } as unknown as User,
      token: 'tok',
      refreshToken: 'ref',
      expiresIn: 900,
    });
    const saveSignPubSpy = vi
      .mocked(cryptoPkg.saveSigningPublicKey)
      .mockResolvedValue();

    await store.register({ username: 'bob', password: 'password123' });

    expect(saveSignPubSpy).toHaveBeenCalledWith('u-reg-1', 'signing-pub');
  });

  it('login does not throw when ensureUserSigningKey fails', async () => {
    const store = useAuthStore();
    vi.spyOn(apiClient.auth, 'login').mockResolvedValue({
      user: makeUser(null),
      token: 'at',
      refreshToken: 'rf',
      expiresIn: 900,
    });
    vi.mocked(cryptoPkg.loadSigningKey).mockRejectedValue(
      new Error('IDB error'),
    );
    vi.mocked(cryptoPkg.loadSigningPublicKey).mockRejectedValue(
      new Error('IDB error'),
    );

    await expect(store.login('alice', 'password')).resolves.toBeUndefined();
    expect(store.isAuthenticated).toBe(true);
  });

  /** Set up the auth store and crypto mocks for a reset test. */
  function setupResetMocks() {
    const store = useAuthStore();
    store.user = { id: 'u-reset', username: 'alice' } as unknown as User;
    store.status = 'authenticated';
    store.identityStatus = 'unavailable';

    const pair = {
      publicKeyRawBase64: 'new-reset-pub',
      privateKey: {} as CryptoKey,
      publicKey: {} as CryptoKey,
    };
    vi.mocked(cryptoPkg.generateSigningKeyPair).mockResolvedValue(pair);
    vi.mocked(cryptoPkg.signProof).mockResolvedValue('proof-sig');
    vi.mocked(cryptoPkg.saveSigningKey).mockResolvedValue();
    vi.mocked(cryptoPkg.saveSigningPublicKey).mockResolvedValue();

    return { store, pair };
  }

  it('resetSigningKey: successful reset generates key, signs proof, calls API, saves keys, updates state', async () => {
    const { store, pair } = setupResetMocks();

    const resetSpy = vi
      .spyOn(apiClient.auth, 'resetSigningKey')
      .mockResolvedValue({
        user: { id: 'u-reset', username: 'alice' } as unknown as User,
      });

    await store.resetSigningKey('password123');

    expect(cryptoPkg.generateSigningKeyPair).toHaveBeenCalledTimes(1);
    expect(cryptoPkg.signProof).toHaveBeenCalledWith(
      pair.privateKey,
      expect.stringContaining('u-reset'),
    );
    expect(resetSpy).toHaveBeenCalledWith({
      password: 'password123',
      signingPublicKey: 'new-reset-pub',
      signature: 'proof-sig',
    });
    expect(cryptoPkg.saveSigningKey).toHaveBeenCalledWith(
      'u-reset',
      pair.privateKey,
    );
    expect(cryptoPkg.saveSigningPublicKey).toHaveBeenCalledWith(
      'u-reset',
      'new-reset-pub',
    );
    expect(store.user?.id).toBe('u-reset');
    expect(store.identityStatus).toBe('ready');
  });

  it('resetSigningKey: failure (401 invalid password) rejects, leaves identityStatus unchanged, does NOT save keys', async () => {
    const { store } = setupResetMocks();

    const { ApiError } = await import('@ponter/api-client');
    vi.spyOn(apiClient.auth, 'resetSigningKey').mockRejectedValue(
      new ApiError('Invalid password', 401, 'INVALID_PASSWORD'),
    );

    await expect(store.resetSigningKey('wrongpass')).rejects.toThrow(
      'Invalid password',
    );

    expect(cryptoPkg.saveSigningKey).not.toHaveBeenCalled();
    expect(cryptoPkg.saveSigningPublicKey).not.toHaveBeenCalled();
    expect(store.identityStatus).toBe('unavailable');
  });

  it('resetSigningKey: when not authenticated (user.value === null) throws "Not authenticated"', async () => {
    const store = useAuthStore();
    store.user = null;
    store.status = 'idle';

    await expect(store.resetSigningKey('password123')).rejects.toThrow(
      'Not authenticated',
    );
  });
});

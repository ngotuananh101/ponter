import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { User } from '@ponter/shared';
import { apiClient } from '@/services/client';
import { tokenStorage } from '@/services/token-storage';
import {
  generateUserKeyPair,
  savePrivateKey,
  savePublicKey,
  generateSigningKeyPair,
  saveSigningKey,
  saveSigningPublicKey,
  loadSigningKey,
  loadSigningPublicKey,
  signProof,
} from '@ponter/crypto';
import { canonicalUserIdentityMessage } from '@ponter/shared';
import { isApiError } from '@ponter/api-client';

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'error';
export type IdentityStatus = 'ready' | 'unavailable';

function describeError(err: unknown, fallback: string): string {
  if (isApiError(err) || err instanceof Error) {
    return err.message;
  }
  return fallback;
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const status = ref<AuthStatus>('idle');
  const error = ref<string | null>(null);
  const requiresApproval = ref<boolean>(false);
  const restored = ref<boolean>(false);
  /**
   * Whether the user's WS2 peer-identity signing key is usable for offers.
   * `ready` iff a local signing key AND a server-side key are both present
   * (either already, or after a successful bootstrap POST). `unavailable`
   * marks the two unrecoverable cases: local key absent + server present
   * (second device), and local key present + server null + no stored public
   * raw (pre-existing account missing only the persistence this change adds).
   */
  const identityStatus = ref<IdentityStatus>('unavailable');

  const isAuthenticated = computed(
    () => user.value !== null && status.value === 'authenticated',
  );

  /**
   * Best-effort bootstrap of the WS2 signing key for legacy accounts.
   *
   * MUST NOT throw: a bootstrap/network/crypto failure must never break login
   * or restore. On unrecoverable states (second device, or a key that cannot
   * be re-registered) it leaves `identityStatus` as `'unavailable'` so the
   * connect path surfaces a typed error instead of a silent proof-less offer.
   *
   * State matrix (PM refinement, 5 cells):
   * 1. local PRIVATE absent + server NULL → generate fresh, save private + save
   *    public raw, POST the new key. (the main legacy case)
   * 2. local PRIVATE present + server NULL + stored PUB present → POST the
   *    stored pub raw signed with the private key. No new generation.
   * 3. local PRIVATE present + server NULL + stored PUB absent → unrecoverable:
   *    the non-extractable private key cannot yield the public raw. Never
   *    fabricate. Set `unavailable`; no POST.
   * 4. local PRIVATE absent + server PRESENT → unrecoverable (second device).
   * 5. both present → no-op.
   */
  async function ensureUserSigningKey(currentUser: User): Promise<void> {
    try {
      const localPrivate = await loadSigningKey(currentUser.id);
      const localPubRaw = await loadSigningPublicKey(currentUser.id);
      const serverKey = currentUser.signingPublicKey;

      // Cell 5: both present — nothing to do.
      if (localPrivate && serverKey) {
        identityStatus.value = 'ready';
        return;
      }

      // Cell 1: local private absent, server NULL → generate fresh.
      if (!localPrivate && !serverKey) {
        const pair = await generateSigningKeyPair();
        await saveSigningKey(currentUser.id, pair.privateKey);
        await saveSigningPublicKey(currentUser.id, pair.publicKeyRawBase64);
        await postSigningKey(
          currentUser.id,
          pair.publicKeyRawBase64,
          pair.privateKey,
        );
        return;
      }

      // Cell 4: local private absent, server present → second device.
      if (!localPrivate && serverKey) {
        identityStatus.value = 'unavailable';
        return;
      }

      // From here: localPrivate is present, serverKey is null (cells 2 & 3).
      // Cell 2: stored public raw present → POST the existing key.
      if (localPubRaw && localPrivate) {
        const signature = await signProof(
          localPrivate,
          canonicalUserIdentityMessage(currentUser.id),
        );
        await postSigningKey(
          currentUser.id,
          localPubRaw,
          localPrivate,
          signature,
        );
        return;
      }

      // Cell 3: local private present but no stored public raw → unrecoverable.
      // The non-extractable private key cannot yield the public raw, so we cannot
      // re-register. Never fabricate a new key (it would not match the server's
      // stored public). Surface honestly.
      identityStatus.value = 'unavailable';
    } catch {
      // Any failure (crypto, IDB, network, 400) must not break login/restore.
      // `identityStatus` stays 'unavailable' (its default) and the connect path
      // reports it explicitly rather than silently offering a proof-less offer.
    }
  }

  /**
   * POST a signing key to the bootstrap endpoint. On a 409 (key already set on
   * the server) treat as success and refresh the user; any other failure is
   * swallowed by `ensureUserSigningKey`'s catch.
   */
  async function postSigningKey(
    userId: string,
    signingPublicKey: string,
    privateKey: CryptoKey,
    signature?: string,
  ): Promise<void> {
    if (signature === undefined) {
      signature = await signProof(
        privateKey,
        canonicalUserIdentityMessage(userId),
      );
    }
    const res = await apiClient.auth.registerSigningKey({
      signingPublicKey,
      signature,
    });
    if (res.user) {
      // Refresh the local user projection so `signingPublicKey` reflects the
      // newly-persisted value.
      user.value = res.user;
      identityStatus.value = 'ready';
    }
  }

  async function restore(): Promise<void> {
    if (restored.value) return;

    const token = await tokenStorage.getAccessToken();
    if (!token) {
      status.value = 'idle';
      restored.value = true;
      return;
    }

    try {
      status.value = 'loading';
      const res = await apiClient.users.me();
      user.value = res.user;
      status.value = 'authenticated';
      // Best-effort bootstrap of the WS2 signing key for legacy accounts.
      // Must NOT break restore: ensureUserSigningKey never throws.
      await ensureUserSigningKey(res.user);
    } catch {
      tokenStorage.clearTokens();
      user.value = null;
      status.value = 'idle';
    } finally {
      restored.value = true;
    }
  }

  async function login(username: string, password: string): Promise<void> {
    status.value = 'loading';
    error.value = null;
    try {
      const res = await apiClient.auth.login(username, password);
      user.value = res.user;
      status.value = 'authenticated';
      // Best-effort bootstrap of the WS2 signing key for legacy accounts.
      // Must NOT break login: ensureUserSigningKey never throws.
      await ensureUserSigningKey(res.user);
    } catch (err) {
      status.value = 'error';
      error.value = describeError(err, 'Login failed');
      throw err;
    }
  }

  async function register(params: {
    username: string;
    email?: string;
    password: string;
  }): Promise<void> {
    status.value = 'loading';
    error.value = null;
    try {
      const keyPair = await generateUserKeyPair();
      const signPair = await generateSigningKeyPair();
      const res = await apiClient.auth.register({
        username: params.username,
        email: params.email,
        password: params.password,
        publicKey: keyPair.publicKeySpkiBase64,
        signingPublicKey: signPair.publicKeyRawBase64,
      });

      // Persist the locally generated private keys BEFORE branching on
      // approval. The server records the matching public keys at registration
      // time even for a pending account, so the private halves can never be
      // regenerated later — a key generated at login would not match. Dropping
      // them here would leave the pending account unable to sign an identity
      // proof, and ADR-41 makes that proof a fail-closed admission gate for
      // every session mode (terminal/desktop/files).
      await savePrivateKey(res.user.id, keyPair.privateKey);
      await savePublicKey(res.user.id, keyPair.publicKey);
      await saveSigningKey(res.user.id, signPair.privateKey);
      // Persist the public raw alongside the private key so that a future
      // bootstrap (e.g. after a server-side reset) can re-register the existing
      // key instead of being stuck in the unrecoverable cell 3 state.
      await saveSigningPublicKey(res.user.id, signPair.publicKeyRawBase64);

      if (res.requiresApproval) {
        status.value = 'idle';
        user.value = null;
        requiresApproval.value = true;
        error.value = null;
        return;
      }

      user.value = res.user;
      requiresApproval.value = false;
      status.value = 'authenticated';
      // Both local key and server key are now present (the latter came from
      // registration), so identity is usable.
      identityStatus.value = 'ready';
    } catch (err) {
      status.value = 'error';
      requiresApproval.value = false;
      error.value = describeError(err, 'Registration failed');
      throw err;
    }
  }

  async function logout(): Promise<void> {
    const refreshToken = await tokenStorage.getRefreshToken();
    // The ECDH identity key is long-lived (WS1/H4): it is the trust anchor for
    // peer identity and session-key binding, so logout must NOT delete it. It is
    // loaded again at the next login.
    try {
      if (refreshToken) {
        await apiClient.auth.logout(refreshToken);
      }
    } catch {
      // Best effort logout server-side
    } finally {
      tokenStorage.clearTokens();
      user.value = null;
      status.value = 'idle';
      error.value = null;
    }
  }

  async function fetchMe(): Promise<void> {
    try {
      const res = await apiClient.users.me();
      user.value = res.user;
      status.value = 'authenticated';
    } catch (err) {
      if (isApiError(err) && err.status === 401) {
        tokenStorage.clearTokens();
        user.value = null;
        status.value = 'idle';
      }
      throw err;
    }
  }

  function clearError(): void {
    error.value = null;
    requiresApproval.value = false;
  }

  // Handle refresh failures emitted by the client
  apiClient.http.onAuthError = () => {
    tokenStorage.clearTokens();
    user.value = null;
    status.value = 'idle';
  };

  return {
    user,
    status,
    error,
    requiresApproval,
    restored,
    isAuthenticated,
    identityStatus,
    ensureUserSigningKey,
    restore,
    login,
    register,
    logout,
    fetchMe,
    clearError,
  };
});

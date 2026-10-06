import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { User } from '@ponter/shared';
import { apiClient } from '@/services/client';
import { tokenStorage } from '@/services/token-storage';
import {
  generateUserKeyPair,
  savePrivateKey,
  generateSigningKeyPair,
  saveSigningKey,
  loadSigningKey,
} from '@ponter/crypto';
import { isApiError } from '@ponter/api-client';

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'error';

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

  const isAuthenticated = computed(
    () => user.value !== null && status.value === 'authenticated',
  );

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
      // Best-effort: load (but don't require) the signing key so identity
      // verification can proceed if a key is present. Must not break login.
      try {
        await loadSigningKey(res.user.id);
      } catch {}
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

      if (res.requiresApproval) {
        status.value = 'idle';
        user.value = null;
        requiresApproval.value = true;
        error.value = null;
        return;
      }

      await savePrivateKey(res.user.id, keyPair.privateKey);
      await saveSigningKey(res.user.id, signPair.privateKey);

      user.value = res.user;
      requiresApproval.value = false;
      status.value = 'authenticated';
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
    restore,
    login,
    register,
    logout,
    fetchMe,
    clearError,
  };
});

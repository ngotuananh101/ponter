import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { User } from '@remote/shared';
import { apiClient } from '@/services/client';
import { tokenStorage } from '@/services/token-storage';
import {
  generateUserKeyPair,
  savePrivateKey,
  deletePrivateKey,
} from '@remote/crypto';
import { isApiError } from '@remote/api-client';

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'error';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const status = ref<AuthStatus>('idle');
  const error = ref<string | null>(null);
  const restored = ref<boolean>(false);

  const isAuthenticated = computed(
    () => user.value !== null && status.value === 'authenticated',
  );

  async function restore(): Promise<void> {
    if (restored.value) return;

    const token = tokenStorage.getAccessToken();
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
    } catch (err) {
      status.value = 'error';
      error.value = isApiError(err)
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Login failed';
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
      const res = await apiClient.auth.register({
        username: params.username,
        email: params.email,
        password: params.password,
        publicKey: keyPair.publicKeySpkiBase64,
      });

      await savePrivateKey(res.user.id, keyPair.privateKey);

      user.value = res.user;
      status.value = 'authenticated';
    } catch (err) {
      status.value = 'error';
      error.value = isApiError(err) ? err.message : 'Registration failed';
      throw err;
    }
  }

  async function logout(): Promise<void> {
    const refreshToken = tokenStorage.getRefreshToken();
    if (user.value?.id) {
      try {
        await deletePrivateKey(user.value.id);
      } catch {
        // ignore storage cleanup failure
      }
    }
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

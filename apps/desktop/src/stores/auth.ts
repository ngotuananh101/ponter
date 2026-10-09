import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { UserProfile } from '@/types';

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'error';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserProfile | null>(null);
  const status = ref<AuthStatus>('idle');
  const error = ref<string | null>(null);

  const isAuthenticated = computed(
    () => user.value !== null && status.value === 'authenticated',
  );

  async function login(username: string, password: string): Promise<void> {
    status.value = 'loading';
    error.value = null;
    try {
      const profile = await invoke<UserProfile>('login', {
        username,
        password,
      });
      user.value = profile;
      status.value = 'authenticated';
    } catch (err) {
      status.value = 'error';
      error.value = err instanceof Error ? err.message : String(err);
      user.value = null;
      throw err;
    }
  }

  async function logout(): Promise<void> {
    try {
      await invoke('logout');
    } finally {
      user.value = null;
      status.value = 'idle';
      error.value = null;
    }
  }

  return {
    user,
    status,
    error,
    isAuthenticated,
    login,
    logout,
  };
});

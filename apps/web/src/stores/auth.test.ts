import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import {
  loadPrivateKey,
  savePrivateKey,
  generateUserKeyPair,
} from '@ponter/crypto';
import { useAuthStore } from './auth';

describe('auth store — H4 key lifecycle', () => {
  beforeEach(async () => {
    const req = indexedDB.deleteDatabase('remote-crypto');
    await new Promise((res, rej) => {
      req.onsuccess = res;
      req.onerror = rej;
    });
    setActivePinia(createPinia());
  });

  it('logout() does not delete the ECDH private key', async () => {
    const store = useAuthStore();
    const { privateKey } = await generateUserKeyPair();
    await savePrivateKey('user-1', privateKey);
    store.user = { id: 'user-1' } as never; // minimal shape for the logout path
    await store.logout();
    expect(await loadPrivateKey('user-1')).not.toBeNull();
  });
});

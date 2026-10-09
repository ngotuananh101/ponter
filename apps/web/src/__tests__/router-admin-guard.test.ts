import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { router } from '@/router';
import { useAuthStore } from '@/stores/auth';
import type { User } from '@ponter/shared';

const makeAdminUser = (): User => ({
  id: 'u1',
  username: 'admin_user',
  email: null,
  publicKey: 'pk',
  signingPublicKey: null,
  role: 'admin',
  approvalStatus: 'approved',
  isActive: true,
  createdAt: '',
  updatedAt: '',
  lastLoginAt: null,
});

const makeRegularUser = (): User => ({
  id: 'u2',
  username: 'normal_user',
  email: null,
  publicKey: 'pk',
  signingPublicKey: null,
  role: 'user',
  approvalStatus: 'approved',
  isActive: true,
  createdAt: '',
  updatedAt: '',
  lastLoginAt: null,
});

describe('Router Admin Guard', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useAuthStore();
    store.restored = true;
    store.user = null;
    store.status = 'idle';
    // Reset router to a neutral route to avoid cross-test leakage
    await router.push('/dashboard');
  });

  it('redirects non-admin user trying to access /admin to /dashboard', async () => {
    const store = useAuthStore();
    store.user = makeRegularUser();
    store.status = 'authenticated';

    await router.push('/admin');
    expect(router.currentRoute.value.path).toBe('/dashboard');
  });

  it('allows admin user to access /admin and stays on /admin', async () => {
    const store = useAuthStore();
    store.user = makeAdminUser();
    store.status = 'authenticated';

    await router.push('/admin');
    expect(router.currentRoute.value.path).toBe('/admin');
  });
});

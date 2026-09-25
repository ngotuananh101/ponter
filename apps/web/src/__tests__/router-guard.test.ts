import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { router } from '@/router';
import { useAuthStore } from '@/stores/auth';
import type { User } from '@remote/shared';

describe('Router Guards', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useAuthStore();
    store.restored = true;
    store.user = null;
    store.status = 'idle';
  });

  it('9. Unauthenticated navigation to /dashboard redirects to /login with redirect query', async () => {
    const store = useAuthStore();
    store.user = null;
    store.status = 'idle';

    await router.push('/dashboard');
    expect(router.currentRoute.value.path).toBe('/login');
    expect(router.currentRoute.value.query.redirect).toBe('/dashboard');
  });

  it('10. Authenticated navigation to /dashboard is allowed', async () => {
    const store = useAuthStore();
    store.user = { id: 'u1', username: 'alice' } as unknown as User;
    store.status = 'authenticated';

    await router.push('/dashboard');
    expect(router.currentRoute.value.path).toBe('/dashboard');
  });

  it('11. Authenticated navigation to /login redirects to /dashboard', async () => {
    const store = useAuthStore();
    store.user = { id: 'u1', username: 'alice' } as unknown as User;
    store.status = 'authenticated';

    await router.push('/login');
    expect(router.currentRoute.value.path).toBe('/dashboard');
  });
});

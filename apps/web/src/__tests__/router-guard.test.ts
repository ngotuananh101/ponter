import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { router } from '@/router';
import { useAuthStore } from '@/stores/auth';
import { apiClient } from '@/services/client';
import { tokenStorage } from '@/services/token-storage';
import type { User } from '@remote/shared';

describe('Router Guards', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    tokenStorage.clearTokens();
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

  it('19. The guard restores the session before deciding, so a stored token keeps the user on /dashboard', async () => {
    const store = useAuthStore();
    store.restored = false; // the guard must do the restoring
    tokenStorage.setTokens({
      accessToken: 'valid-token',
      refreshToken: 'valid-ref',
    });
    vi.spyOn(apiClient.users, 'me').mockResolvedValue({
      user: { id: 'u1', username: 'alice' } as unknown as User,
    });

    // Force a navigation from a different route to ensure the guard runs
    await router.push('/login');
    await router.push('/dashboard');

    expect(store.restored).toBe(true);
    expect(router.currentRoute.value.path).toBe('/dashboard');
  });
});

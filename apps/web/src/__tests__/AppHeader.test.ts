import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import AppHeader from '@/components/layout/AppHeader.vue';
import { useAuthStore } from '@/stores/auth';
import type { User } from '@ponter/shared';

function makeUser(role: 'admin' | 'user'): User {
  return {
    id: 'u1',
    username: 'testuser',
    email: 'test@example.com',
    publicKey: 'pk',
    signingPublicKey: null,
    role,
    approvalStatus: 'approved',
    isActive: true,
    createdAt: '',
    updatedAt: '',
    lastLoginAt: null,
  };
}

describe('AppHeader.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function mountWithRouter() {
    const router = createRouter({
      history: createWebHistory(),
      routes: [
        { path: '/', name: 'home', component: { template: '<div/>' } },
        { path: '/admin', name: 'admin', component: { template: '<div/>' } },
        {
          path: '/dashboard',
          name: 'dashboard',
          component: { template: '<div/>' },
        },
        { path: '/login', name: 'login', component: { template: '<div/>' } },
      ],
    });
    return {
      wrapper: mount(AppHeader, {
        global: {
          plugins: [router],
        },
      }),
      router,
    };
  }

  it('renders the Admin link when the current user is an admin', async () => {
    const store = useAuthStore();
    store.user = makeUser('admin');
    store.status = 'authenticated';

    const { wrapper } = mountWithRouter();
    await wrapper.vm.$nextTick();

    const adminLink = wrapper.find('a[href="/admin"]');
    expect(adminLink.exists()).toBe(true);
    expect(adminLink.text()).toContain('Admin');
  });

  it('does not render the Admin link for a regular user', async () => {
    const store = useAuthStore();
    store.user = makeUser('user');
    store.status = 'authenticated';

    const { wrapper } = mountWithRouter();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('a[href="/admin"]').exists()).toBe(false);
  });

  it('does not render the Admin link when there is no authenticated user', async () => {
    const store = useAuthStore();
    store.user = null;
    store.status = 'idle';

    const { wrapper } = mountWithRouter();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('a[href="/admin"]').exists()).toBe(false);
  });

  it('renders Reset Identity Key dialog and dropdown item when authenticated', async () => {
    const store = useAuthStore();
    store.user = makeUser('user');
    store.status = 'authenticated';

    const { wrapper } = mountWithRouter();
    await wrapper.vm.$nextTick();

    const dialog = wrapper.findComponent({ name: 'ResetIdentityKeyDialog' });
    expect(dialog.exists()).toBe(true);
    expect(dialog.props('open')).toBe(false);

    // Trigger button for dropdown
    const avatarBtn = wrapper.find('button.rounded-full');
    expect(avatarBtn.exists()).toBe(true);
    await avatarBtn.trigger('click');
    await wrapper.vm.$nextTick();

    // In happy-dom / reka-ui, dropdown menu is teleported to document body
    const resetItem = document.querySelector(
      '[data-test="header-reset-identity-key"]',
    );
    expect(resetItem).not.toBeNull();
    expect(resetItem?.textContent).toContain('Reset Identity Key');

    (resetItem as HTMLElement).click();
    await wrapper.vm.$nextTick();
    expect(dialog.props('open')).toBe(true);
  });
});

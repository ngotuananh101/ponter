import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ResetIdentityKeyDialog from '@/components/auth/ResetIdentityKeyDialog.vue';
import { useAuthStore } from '@/stores/auth';
import { toast } from 'vue-sonner';

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/services/client', () => ({
  apiClient: {
    http: { onAuthError: null },
  },
}));

vi.mock('@ponter/crypto', () => ({
  generateSigningKeyPair: vi.fn(),
  saveSigningKey: vi.fn(),
  saveSigningPublicKey: vi.fn(),
  signProof: vi.fn(),
}));

vi.mock('@ponter/api-client', () => ({
  isApiError: vi.fn(),
}));

vi.mock('@/services/token-storage', () => ({
  tokenStorage: {
    getAccessToken: vi.fn(),
    getRefreshToken: vi.fn(),
    setTokens: vi.fn(),
    clearTokens: vi.fn(),
  },
}));

const STUBS = {
  Teleport: {
    template: '<slot />',
  },
};

function mountDialog(open: boolean) {
  return mount(ResetIdentityKeyDialog, {
    props: { open },
    global: { stubs: STUBS },
  });
}

describe('ResetIdentityKeyDialog.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('renders with a password input and submit/cancel buttons', () => {
    const wrapper = mountDialog(true);

    expect(
      wrapper.find('[data-test="reset-identity-key-dialog"]').exists(),
    ).toBe(true);
    expect(wrapper.find('input[type="password"]').exists()).toBe(true);
    expect(
      wrapper.find('[data-test="reset-identity-key-submit"]').exists(),
    ).toBe(true);
    expect(
      wrapper.find('[data-test="reset-identity-key-cancel"]').exists(),
    ).toBe(true);
  });

  it('submitting password calls authStore.resetSigningKey, triggers toast.success, emits success and closes dialog', async () => {
    const wrapper = mountDialog(true);
    const authStore = useAuthStore();
    const resetSpy = vi
      .spyOn(authStore, 'resetSigningKey')
      .mockResolvedValue(undefined);

    await wrapper.find('input[type="password"]').setValue('password123');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();

    expect(resetSpy).toHaveBeenCalledWith('password123');
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(
      'Identity key reset successfully',
    );
    expect(wrapper.emitted('success')).toHaveLength(1);
    expect(wrapper.emitted('update:open')).toContainEqual([false]);
  });

  it('submission failure displays error alert', async () => {
    const wrapper = mountDialog(true);
    const authStore = useAuthStore();
    vi.spyOn(authStore, 'resetSigningKey').mockRejectedValue(
      new Error('Invalid password'),
    );

    await wrapper.find('input[type="password"]').setValue('wrongpass');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();

    const alert = wrapper.find('[data-test="reset-identity-key-error"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('Invalid password');
  });

  it('cancel button resets password and error fields', async () => {
    const wrapper = mountDialog(true);
    const authStore = useAuthStore();
    vi.spyOn(authStore, 'resetSigningKey').mockRejectedValue(
      new Error('Invalid password'),
    );

    await wrapper.find('input[type="password"]').setValue('wrongpass');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();

    expect(
      wrapper.find('[data-test="reset-identity-key-error"]').exists(),
    ).toBe(true);

    await wrapper
      .find('[data-test="reset-identity-key-cancel"]')
      .trigger('click');

    expect(
      wrapper.find('[data-test="reset-identity-key-error"]').exists(),
    ).toBe(false);
  });
});

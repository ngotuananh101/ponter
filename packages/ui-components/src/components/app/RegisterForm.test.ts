import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import RegisterForm from './RegisterForm.vue';

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { toast } from 'vue-sonner';

// Mount the form, fill the named fields, and submit. Extracted so the four
// cases below share one copy of the boilerplate instead of repeating it
// verbatim (SonarCloud new-code duplication). Behaviour is identical: the same
// fields are filled in the same order and the same submit is triggered.
async function mountAndSubmit(fields: Record<string, string>) {
  const wrapper = mount(RegisterForm, {
    global: { stubs: { RouterLink: true } },
  });
  for (const [id, value] of Object.entries(fields)) {
    await wrapper.find(`#${id}`).setValue(value);
  }
  await wrapper.find('form').trigger('submit.prevent');
  return wrapper;
}

describe('RegisterForm.vue', () => {
  it.each<{ name: string; fields: Record<string, string>; message: string }>([
    {
      name: '19. A mismatched password confirmation calls toast.error and does not emit',
      fields: {
        'reg-username': 'alice',
        'reg-password': 'password123',
        'reg-confirm-password': 'password456',
      },
      message: 'Passwords do not match',
    },
    {
      name: '20. A password shorter than 8 characters calls toast.error',
      fields: {
        'reg-username': 'alice',
        'reg-password': 'short',
        'reg-confirm-password': 'short',
      },
      message: 'Password must be at least 8 characters',
    },
    {
      name: '21. A malformed email calls toast.error',
      fields: {
        'reg-username': 'alice',
        'reg-email': 'not-an-email',
        'reg-password': 'password123',
        'reg-confirm-password': 'password123',
      },
      message: 'Please enter a valid email address',
    },
  ])('$name', async ({ fields, message }) => {
    const wrapper = await mountAndSubmit(fields);

    expect(toast.error).toHaveBeenCalledWith(message);
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('22. A valid form emits submit with entered fields', async () => {
    const wrapper = await mountAndSubmit({
      'reg-username': 'alice',
      'reg-email': 'alice@example.com',
      'reg-password': 'password123',
      'reg-confirm-password': 'password123',
    });

    expect(wrapper.emitted('submit')).toHaveLength(1);
    expect(wrapper.emitted('submit')![0]).toEqual([
      {
        username: 'alice',
        email: 'alice@example.com',
        password: 'password123',
      },
    ]);
  });
});

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Sonner from '@/components/ui/sonner/Sonner.vue';

// The real vue-sonner Toaster renders an <ol data-sonner-toaster> in happy-dom.
// We mount the shadcn Sonner wrapper directly (no mock) and assert the root
// renders, proving the Toaster is wired into the component tree.
describe('Sonner.vue (Toaster wiring)', () => {
  it('renders the sonner toaster root element', () => {
    const wrapper = mount(Sonner, {
      props: {
        position: 'top-right',
        richColors: true,
        closeButton: true,
      },
    });

    // The real vue-sonner Toaster renders an <ol data-sonner-toaster>.
    expect(wrapper.find('ol[data-sonner-toaster]').exists()).toBe(true);
  });
});

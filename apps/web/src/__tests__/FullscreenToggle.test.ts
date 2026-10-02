import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import FullscreenToggle from '@/components/terminal/FullscreenToggle.vue';

describe('FullscreenToggle.vue', () => {
  it('renders nothing when the browser lacks the Fullscreen API', () => {
    const wrapper = mount(FullscreenToggle, {
      props: { active: false, supported: false },
    });
    expect(wrapper.find('[data-test="fullscreen-toggle"]').exists()).toBe(
      false,
    );
  });

  it('shows an enter control when not fullscreen and emits toggle', async () => {
    const wrapper = mount(FullscreenToggle, {
      props: { active: false, supported: true, label: 'host-a' },
    });

    const button = wrapper.find('[data-test="fullscreen-toggle"]');
    expect(button.exists()).toBe(true);
    expect(button.attributes('aria-pressed')).toBe('false');
    expect(button.attributes('aria-label')).toContain('Enter fullscreen');
    expect(button.attributes('aria-label')).toContain('host-a');

    await button.trigger('click');
    expect(wrapper.emitted('toggle')).toHaveLength(1);
  });

  it('reflects the fullscreen state with a pressed control', () => {
    const wrapper = mount(FullscreenToggle, {
      props: { active: true, supported: true },
    });

    const button = wrapper.find('[data-test="fullscreen-toggle"]');
    expect(button.attributes('aria-pressed')).toBe('true');
    expect(button.attributes('aria-label')).toContain('Exit fullscreen');
    expect(button.attributes('title')).toBe('Exit fullscreen');
  });
});

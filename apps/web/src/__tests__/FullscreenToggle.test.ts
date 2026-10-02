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

  // The two placements want opposite treatments, and the tab strip (the only
  // caller) uses the inline one. A regression that dropped the variant branch
  // would leave the button absolutely positioned over the terminal instead of
  // sitting beside "+", so pin both shapes.
  it('floats over the session by default (overlay variant)', () => {
    const wrapper = mount(FullscreenToggle, {
      props: { active: false, supported: true },
    });

    const button = wrapper.find('[data-test="fullscreen-toggle"]');
    expect(button.classes()).toContain('absolute');
    expect(button.classes()).toContain('backdrop-blur-sm');
    expect(button.classes()).not.toContain('flex-shrink-0');
  });

  it('renders as a flat inline control in the tab strip', () => {
    const wrapper = mount(FullscreenToggle, {
      props: { active: false, supported: true, variant: 'inline' },
    });

    const button = wrapper.find('[data-test="fullscreen-toggle"]');
    // Inline sits in flow beside "+": no absolute positioning, no floating
    // surface — just the flat hover treatment the neighbouring buttons use.
    expect(button.classes()).not.toContain('absolute');
    expect(button.classes()).toContain('flex-shrink-0');
    expect(button.classes()).toContain('hover:bg-muted');
    expect(button.classes()).not.toContain('backdrop-blur-sm');
    // The inline icon is sized to match the "+" (w-4), not the overlay's w-3.5.
    expect(button.find('svg').classes()).toContain('w-4');
  });
});

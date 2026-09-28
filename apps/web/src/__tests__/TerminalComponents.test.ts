import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import TerminalTabBar from '../components/terminal/TerminalTabBar.vue';
import MobileAccessoryBar from '../components/terminal/MobileAccessoryBar.vue';

describe('TerminalTabBar.vue', () => {
  it('renders tab items and handles select / close events', async () => {
    const tabs = [
      { id: 't1', title: 'Shell 1', status: 'active' },
      { id: 't2', title: 'Shell 2', status: 'connecting' },
    ];
    const wrapper = mount(TerminalTabBar, {
      props: {
        tabs,
        activeTabId: 't1',
      },
    });

    expect(wrapper.text()).toContain('Shell 1');
    expect(wrapper.text()).toContain('Shell 2');

    await wrapper.find('[data-test="close-tab-t1"]').trigger('click');
    expect(wrapper.emitted('closeTab')?.[0]).toEqual(['t1']);
  });

  it('emits selectTab when clicking an inactive tab', async () => {
    const tabs = [
      { id: 't1', title: 'Shell 1', status: 'active' },
      { id: 't2', title: 'Shell 2', status: 'exited' },
    ];
    const wrapper = mount(TerminalTabBar, {
      props: {
        tabs,
        activeTabId: 't1',
      },
    });

    // The second tab is the inactive one; clicking its main element (not the close button)
    // should emit selectTab with its id.
    const tabElements = wrapper.findAll('div.cursor-pointer');
    expect(tabElements).toHaveLength(2);
    await tabElements[1]!.trigger('click');
    expect(wrapper.emitted('selectTab')?.[0]).toEqual(['t2']);
  });

  it('emits newTab when the new tab button is clicked', async () => {
    const wrapper = mount(TerminalTabBar, {
      props: {
        tabs: [],
        activeTabId: null,
      },
    });
    await wrapper.find('button[title="Open new tab"]').trigger('click');
    expect(wrapper.emitted('newTab')).toHaveLength(1);
  });
});

describe('MobileAccessoryBar.vue', () => {
  it('emits key event on key button pointerdown', async () => {
    const wrapper = mount(MobileAccessoryBar);
    const escBtn = wrapper.find('[data-key="Escape"]');
    expect(escBtn.exists()).toBe(true);

    await escBtn.trigger('pointerdown');
    expect(wrapper.emitted('sendKey')?.[0]).toEqual(['\x1b']);
  });

  it('renders all expected virtual keys', () => {
    const wrapper = mount(MobileAccessoryBar);
    const keys = ['Escape', 'Tab', 'CtrlC', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Pipe', 'Slash', 'Tilde', 'Dash'];
    keys.forEach((k) => {
      expect(wrapper.find(`[data-key="${k}"]`).exists()).toBe(true);
    });
  });
});

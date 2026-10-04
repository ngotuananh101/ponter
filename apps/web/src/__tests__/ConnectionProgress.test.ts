import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ConnectionProgress from '@/components/terminal/ConnectionProgress.vue';
import type { TabItem } from '@/stores/terminal';

function tab(overrides: Partial<TabItem> = {}): TabItem {
  return {
    id: 'tab-1',
    agentId: 'ag-1',
    kind: 'terminal',
    terminalId: '',
    title: 'host-a',
    status: 'connecting',
    initStep: 'session',
    ...overrides,
  };
}

describe('ConnectionProgress.vue', () => {
  it('lists the terminal steps and marks the current one active', () => {
    const wrapper = mount(ConnectionProgress, {
      props: { tab: tab({ initStep: 'negotiating' }) },
    });

    const text = wrapper.text();
    expect(text).toContain('Creating session');
    expect(text).toContain('Preparing connection');
    expect(text).toContain('Negotiating WebRTC channel');
    expect(text).toContain('Opening shell');
    expect(text).toContain('Connecting to');

    // Steps before the current one are done (a check icon), the current one
    // spins. Assert the data-state contract rather than styling.
    const items = wrapper.findAll('li');
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.attributes('data-state'))).toEqual([
      'done',
      'done',
      'active',
      'pending',
    ]);
    // The active step spins; the two done steps carry the check icon.
    expect(items[2]!.find('svg').exists()).toBe(true);
    expect(items[0]!.find('svg').exists()).toBe(true);
    expect(items[1]!.find('svg').exists()).toBe(true);
    // The pending step renders a dot, not an icon.
    expect(items[3]!.find('svg').exists()).toBe(false);
  });

  it('renders the desktop-specific final step', () => {
    const wrapper = mount(ConnectionProgress, {
      props: {
        tab: tab({ kind: 'desktop', initStep: 'stream', title: 'Host D' }),
      },
    });

    const text = wrapper.text();
    expect(text).toContain('Negotiating video stream');
    expect(text).not.toContain('Opening shell');
    expect(text).toContain('Host D');
  });

  it('renders the files-specific final step', () => {
    const wrapper = mount(ConnectionProgress, {
      props: {
        tab: tab({ kind: 'files', initStep: 'channel', title: 'Host F' }),
      },
    });

    const text = wrapper.text();
    expect(text).toContain('Opening file channel');
    expect(text).not.toContain('Opening shell');

    const items = wrapper.findAll('li');
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.attributes('data-state'))).toEqual([
      'done',
      'done',
      'done',
      'active',
    ]);
  });

  it('exposes the step list as a polite live region for screen readers', () => {
    const wrapper = mount(ConnectionProgress, { props: { tab: tab() } });
    const region = wrapper.find('[role="status"]');
    expect(region.exists()).toBe(true);
    expect(region.attributes('aria-live')).toBe('polite');
  });
});

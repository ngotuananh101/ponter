import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import DesktopView from '@/components/desktop/DesktopView.vue';
import { useTerminalStore } from '@/stores/terminal';
import type { TabItem } from '@/stores/terminal';

function desktopTab(overrides: Partial<TabItem> = {}): TabItem {
  return {
    id: 'tab-1',
    agentId: 'ag-1',
    kind: 'desktop',
    terminalId: '',
    title: 'Host 1',
    status: 'active',
    ...overrides,
  };
}

describe('DesktopView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders a video element with no controls (view-only)', () => {
    const wrapper = mount(DesktopView, { props: { tab: desktopTab() } });
    const video = wrapper.find('video');
    expect(video.exists()).toBe(true);
    expect(video.attributes('controls')).toBeUndefined();
    expect(video.attributes('muted')).toBeDefined();
    expect(video.attributes('autoplay')).toBeDefined();
  });

  it('shows the error overlay and a Retry button when the tab errored', async () => {
    const store = useTerminalStore();
    const retry = vi.spyOn(store, 'retryTab').mockResolvedValue();
    const wrapper = mount(DesktopView, {
      props: { tab: desktopTab({ status: 'error', error: 'no route' }) },
    });
    expect(wrapper.text()).toContain('no route');
    await wrapper.find('[data-test="retry-desktop-tab-1"]').trigger('click');
    expect(retry).toHaveBeenCalledWith('tab-1');
  });

  it('attaches the stream to the video element on mount', () => {
    const stream = { track: { kind: 'video' }, streams: [] };
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({ desktopStream: stream as never }),
      },
    });
    const video = wrapper.find('video').element as HTMLVideoElement;
    // The element must carry the stream at mount, not only after the reactive
    // watcher fires — a remount with the stream already present is the case the
    // watcher misses, and it is the case this asserts.
    expect(video.srcObject).not.toBeNull();
  });

  it('clears srcObject on unmount', () => {
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({
          desktopStream: { track: { kind: 'video' }, streams: [] } as never,
        }),
      },
    });
    const video = wrapper.find('video').element as HTMLVideoElement;
    wrapper.unmount();
    expect(video.srcObject).toBeNull();
  });
});

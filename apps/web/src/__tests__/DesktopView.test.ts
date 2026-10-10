import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
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

const mountDesktop = (overrides: Partial<TabItem> = {}) =>
  mount(DesktopView, { props: { tab: desktopTab(overrides) } });

describe('DesktopView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders a video element with no native controls', () => {
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

  const twoSources = [
    {
      id: 'monitor:1',
      kind: 'monitor' as const,
      name: 'eDP-1',
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
      scaleFactor: 1,
      rotation: 0,
      isPrimary: true,
      default: true,
    },
    {
      id: 'window:9',
      kind: 'window' as const,
      name: 'Editor',
      width: 800,
      height: 600,
      x: 100,
      y: 100,
      scaleFactor: 1,
      rotation: 0,
      isPrimary: false,
      default: false,
    },
  ];

  /**
   * The chrome (source picker, bitrate, input toggle) renders only once the tab
   * has sources or stats, so tests that touch it mount with sources present.
   */
  const mountWithChrome = (overrides: Partial<TabItem> = {}) =>
    mountDesktop({
      desktopSources: twoSources,
      desktopSourceId: 'monitor:1',
      ...overrides,
    });

  it('renders the source picker only when sources are present', async () => {
    const withoutSources = mount(DesktopView, {
      props: { tab: desktopTab() },
    });
    expect(
      withoutSources.find('[data-test="desktop-source-picker"]').exists(),
    ).toBe(false);

    const withSources = mount(DesktopView, {
      props: {
        tab: desktopTab({
          desktopSources: twoSources,
          desktopSourceId: 'monitor:1',
        }),
      },
    });
    const picker = withSources.find('[data-test="desktop-source-picker"]');
    expect(picker.exists()).toBe(true);
    expect(picker.findAll('option')).toHaveLength(2);
  });

  it('associates the source picker with a label (accessible name)', () => {
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({
          desktopSources: twoSources,
          desktopSourceId: 'monitor:1',
        }),
      },
    });
    const picker = wrapper.find('[data-test="desktop-source-picker"]');
    // A bare <select> has no accessible name — the control is announced as an
    // unnamed combobox. SonarCloud's `InputWithoutLabelCheck` fails the gate on
    // it, and it is a real a11y regression for a screen-reader user. Assert the
    // *association* (`select.labels`), not mere ancestor containment: a future
    // wrapper <label> around the whole chrome would satisfy `closest('label')`
    // while leaving the select unnamed.
    const select = picker.element as HTMLSelectElement;
    expect(select.labels).toHaveLength(1);
    expect(select.labels[0]!.control).toBe(select);
    expect(select.labels[0]!.textContent).toContain('Source');
    // The label must name the picker alone — not wrap the neighbouring bitrate
    // control, which would give both controls the same (wrong) accessible name.
    expect(select.labels[0]!.textContent).not.toContain('Bitrate');
  });

  it('calls selectDesktopSource when the picker changes', async () => {
    const store = useTerminalStore();
    const select = vi
      .spyOn(store, 'selectDesktopSource')
      .mockImplementation(() => {});
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({
          desktopSources: twoSources,
          desktopSourceId: 'monitor:1',
        }),
      },
    });

    await wrapper
      .find('[data-test="desktop-source-picker"]')
      .setValue('window:9');

    expect(select).toHaveBeenCalledWith('tab-1', 'window:9');
  });

  it('renders the stats line and appends a status note when present', () => {
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({
          desktopStats: {
            width: 1280,
            height: 720,
            fps: 30,
            targetBitrateBps: 4_000_000,
            status: {
              kind: 'quality-downgraded',
              detail: '720p (quality downgraded)',
            },
          },
        }),
      },
    });
    expect(wrapper.find('[data-test="desktop-stats"]').text()).toContain(
      '1280×720',
    );
    expect(wrapper.find('[data-test="desktop-stats"]').text()).toContain(
      '30 fps',
    );
    expect(wrapper.find('[data-test="desktop-stats"]').text()).toContain(
      'quality downgraded',
    );
  });

  it('leaves the bitrate input empty until the first stats frame', async () => {
    // Sources present (so the footer renders) but no stats yet: the bitrate
    // control lives inside the gear popover, which must be opened first.
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({
          desktopSources: twoSources,
          desktopSourceId: 'monitor:1',
        }),
      },
    });

    await wrapper
      .find('[data-test="desktop-settings-toggle"]')
      .trigger('click');

    // A hardcoded 6 Mbps default would show a number the agent never sent —
    // the session may sit at the 720p30 floor. Before any stats, show nothing.
    const input = wrapper.find<HTMLInputElement>(
      '[data-test="desktop-bitrate"]',
    );
    expect(input.element.value).toBe('');
  });

  it('calls setDesktopBitrate from the bitrate control', async () => {
    const store = useTerminalStore();
    const setBitrate = vi
      .spyOn(store, 'setDesktopBitrate')
      .mockImplementation(() => {});
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({
          desktopStats: {
            width: 1920,
            height: 1080,
            fps: 30,
            targetBitrateBps: 6_000_000,
          },
        }),
      },
    });

    await wrapper
      .find('[data-test="desktop-settings-toggle"]')
      .trigger('click');

    await wrapper.find('[data-test="desktop-bitrate"]').setValue('3000000');

    expect(setBitrate).toHaveBeenCalledWith('tab-1', 3_000_000);
  });

  it('toggles the gear settings popover to reveal the bitrate input', async () => {
    const wrapper = mountWithChrome();

    // Initially the bitrate input is hidden inside the closed gear popover.
    expect(wrapper.find('[data-test="desktop-bitrate"]').exists()).toBe(false);

    await wrapper
      .find('[data-test="desktop-settings-toggle"]')
      .trigger('click');
    expect(wrapper.find('[data-test="desktop-bitrate"]').exists()).toBe(true);

    await wrapper
      .find('[data-test="desktop-settings-toggle"]')
      .trigger('click');
    expect(wrapper.find('[data-test="desktop-bitrate"]').exists()).toBe(false);
  });

  it('forwards nothing while the agent gate is closed', async () => {
    const store = useTerminalStore();
    const select = vi
      .spyOn(store, 'selectDesktopSource')
      .mockImplementation(() => {});
    const setBitrate = vi
      .spyOn(store, 'setDesktopBitrate')
      .mockImplementation(() => {});
    const sendInput = vi
      .spyOn(store, 'sendDesktopInput')
      .mockImplementation(() => {});
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({
          desktopSources: twoSources,
          desktopSourceId: 'monitor:1',
          desktopStats: {
            width: 1920,
            height: 1080,
            fps: 30,
            targetBitrateBps: 6_000_000,
          },
          // The production default: the agent never opened its input gate.
          desktopInputEnabled: false,
        }),
      },
    });
    const video = wrapper.find('video');
    expect(video.attributes('controls')).toBeUndefined();

    // Asserting the *absence* of a rendered `onpointermove` attribute is
    // vacuous — Vue attaches listeners via addEventListener and never renders
    // them as attributes. Dispatch the real events instead and prove nothing is
    // forwarded: this fails if any input handler is wired to the video.
    await video.trigger('pointermove');
    await video.trigger('pointerdown');
    await video.trigger('pointerup');
    await video.trigger('wheel');
    await video.trigger('keydown');
    await video.trigger('keyup');

    expect(sendInput).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(setBitrate).not.toHaveBeenCalled();
  });

  it('renders no input toggle when the agent gate is closed', () => {
    const wrapper = mountWithChrome({
      desktopInputEnabled: false,
      desktopPeerVerified: true,
    });
    expect(wrapper.find('[data-test="desktop-input-toggle"]').exists()).toBe(
      false,
    );
  });

  it('renders the toggle and attaches no listeners until it is on', async () => {
    const store = useTerminalStore();
    const sendInput = vi
      .spyOn(store, 'sendDesktopInput')
      .mockImplementation(() => {});
    const wrapper = mountWithChrome({
      desktopInputEnabled: true,
      desktopPeerVerified: true,
    });
    const toggle = wrapper.find('[data-test="desktop-input-toggle"]');
    expect(toggle.exists()).toBe(true);

    // Before enabling: a pointermove on the video forwards nothing.
    await wrapper
      .find('video')
      .trigger('pointermove', { clientX: 10, clientY: 10 });
    expect(sendInput).not.toHaveBeenCalled();

    await toggle.trigger('click');
    await wrapper
      .find('video')
      .trigger('pointermove', { clientX: 10, clientY: 10 });
    expect(sendInput).toHaveBeenCalled();
  });

  it('forwards a click and a key with normalized coordinates once enabled', async () => {
    const store = useTerminalStore();
    const sendInput = vi
      .spyOn(store, 'sendDesktopInput')
      .mockImplementation(() => {});
    const wrapper = mountWithChrome({
      desktopInputEnabled: true,
      desktopPeerVerified: true,
    });
    await wrapper.find('[data-test="desktop-input-toggle"]').trigger('click');

    await wrapper.find('video').trigger('pointerdown', {
      clientX: 10,
      clientY: 10,
      button: 2,
    });
    await wrapper.find('video').trigger('keydown', {
      code: 'KeyA',
      ctrlKey: true,
    });

    expect(sendInput).toHaveBeenCalledWith('tab-1', {
      kind: 'pointer-button',
      button: 'right',
      pressed: true,
      x: 0,
      y: 0,
    });
    expect(sendInput).toHaveBeenCalledWith('tab-1', {
      kind: 'key',
      code: 'KeyA',
      pressed: true,
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
    });
  });

  it('drops the local toggle when the gate closes', async () => {
    const store = useTerminalStore();
    const sendInput = vi
      .spyOn(store, 'sendDesktopInput')
      .mockImplementation(() => {});
    const wrapper = mountWithChrome({
      desktopInputEnabled: true,
      desktopPeerVerified: true,
    });
    await wrapper.find('[data-test="desktop-input-toggle"]').trigger('click');

    // The agent can close the gate mid-session (a new desktop-sources frame).
    await wrapper.setProps({
      tab: desktopTab({
        desktopSources: twoSources,
        desktopSourceId: 'monitor:1',
        desktopInputEnabled: false,
      }),
    });

    await wrapper
      .find('video')
      .trigger('pointermove', { clientX: 10, clientY: 10 });
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('focuses the video when input is enabled so keys reach it', async () => {
    // Keydown fires on the focused element; a video with a tabindex is still
    // not focused by default, so enabling input must move focus there (spec
    // §7.2) — otherwise typing lands on nothing until the user clicks first.
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({
          desktopSources: twoSources,
          desktopSourceId: 'monitor:1',
          desktopInputEnabled: true,
          desktopPeerVerified: true,
        }),
      },
      // Attached to the document: `focus()` on a detached element does not
      // move `document.activeElement`, so an unattached mount cannot prove it.
      attachTo: document.body,
    });
    await wrapper.find('[data-test="desktop-input-toggle"]').trigger('click');
    await flushPromises();
    await nextTick();

    expect(document.activeElement).toBe(wrapper.find('video').element);
    wrapper.unmount();
  });

  it('renders the verified badge only when the peer is verified', () => {
    const verified = mountWithChrome({ desktopPeerVerified: true });
    expect(verified.find('[data-test="desktop-peer-verified"]').exists()).toBe(
      true,
    );
    expect(
      verified.find('[data-test="desktop-peer-verified"]').text(),
    ).toContain('Verified peer');

    const unverified = mountWithChrome({ desktopPeerVerified: false });
    expect(
      unverified.find('[data-test="desktop-peer-verified"]').exists(),
    ).toBe(false);
    const missing = mountWithChrome();
    expect(missing.find('[data-test="desktop-peer-verified"]').exists()).toBe(
      false,
    );
  });

  it('hides the input toggle when the peer is unverified even with the gate open', () => {
    const wrapper = mountWithChrome({
      desktopInputEnabled: true,
      desktopPeerVerified: false,
    });
    expect(wrapper.find('[data-test="desktop-input-toggle"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('[data-test="desktop-input-status"]').exists()).toBe(
      false,
    );
  });

  it('reads View only before enabling input and Controlling after', async () => {
    const wrapper = mountWithChrome({
      desktopInputEnabled: true,
      desktopPeerVerified: true,
    });
    const status = wrapper.find('[data-test="desktop-input-status"]');
    expect(status.exists()).toBe(true);
    expect(status.text()).toBe('View only');

    await wrapper.find('[data-test="desktop-input-toggle"]').trigger('click');
    await flushPromises();
    await nextTick();

    expect(wrapper.find('[data-test="desktop-input-status"]').text()).toBe(
      'Controlling',
    );
  });

  it('still renders the <video> with no controls when input is enabled', () => {
    const wrapper = mountWithChrome({
      desktopInputEnabled: true,
      desktopPeerVerified: true,
    });
    expect(wrapper.find('video').attributes('controls')).toBeUndefined();
  });

  describe('cursor overlay canvas', () => {
    it('renders a video with cursor-none class when inputOn is true', async () => {
      const wrapper = mountWithChrome({
        desktopInputEnabled: true,
        desktopPeerVerified: true,
      });
      await wrapper.find('[data-test="desktop-input-toggle"]').trigger('click');
      await flushPromises();
      await nextTick();
      const video = wrapper.find('video');
      expect(video.classes()).toContain('cursor-none');
    });

    it('does not add cursor-none when input is off', () => {
      const wrapper = mountWithChrome({
        desktopInputEnabled: true,
        desktopPeerVerified: true,
      });
      const video = wrapper.find('video');
      expect(video.classes()).not.toContain('cursor-none');
    });

    it('renders an overlay canvas with the expected data-test attribute', () => {
      const wrapper = mountWithChrome({
        desktopInputEnabled: true,
        desktopPeerVerified: true,
      });
      const canvas = wrapper.find('[data-test="desktop-cursor-canvas"]');
      expect(canvas.exists()).toBe(true);
      expect(canvas.element.tagName.toLowerCase()).toBe('canvas');
    });

    it('positions the canvas with pointer-events-none absolute inset-0', () => {
      const wrapper = mountWithChrome();
      const canvas = wrapper.find('[data-test="desktop-cursor-canvas"]');
      expect(canvas.classes()).toContain('pointer-events-none');
      expect(canvas.classes()).toContain('absolute');
      expect(canvas.classes()).toContain('inset-0');
    });

    it('hides the overlay canvas when desktopCursorInFrame is true', async () => {
      const wrapper = mountWithChrome();
      const canvas = wrapper.find('[data-test="desktop-cursor-canvas"]');
      expect(canvas.classes()).not.toContain('hidden');

      await wrapper.setProps({
        tab: desktopTab({
          desktopSources: twoSources,
          desktopSourceId: 'monitor:1',
          desktopCursorInFrame: true,
        }),
      });
      expect(canvas.classes()).toContain('hidden');
    });

    it('hides the overlay canvas when cursor visible is false', async () => {
      const wrapper = mountWithChrome();
      await wrapper.setProps({
        tab: desktopTab({
          desktopSources: twoSources,
          desktopSourceId: 'monitor:1',
          desktopCursor: {
            x: 0.5,
            y: 0.5,
            visible: false,
            seq: 1,
          },
        }),
      });
      const canvas = wrapper.find('[data-test="desktop-cursor-canvas"]');
      expect(canvas.classes()).toContain('hidden');
    });

    it('shows the overlay canvas when cursor is visible and in-frame is false', async () => {
      const wrapper = mountWithChrome();
      await wrapper.setProps({
        tab: desktopTab({
          desktopSources: twoSources,
          desktopSourceId: 'monitor:1',
          desktopCursor: {
            x: 0.5,
            y: 0.5,
            visible: true,
            seq: 1,
          },
          desktopCursorInFrame: false,
        }),
      });
      const canvas = wrapper.find('[data-test="desktop-cursor-canvas"]');
      expect(canvas.classes()).not.toContain('hidden');
    });

    it('draws the local-echo arrow at the local pointer position while controlling', async () => {
      const store = useTerminalStore();
      vi.spyOn(store, 'sendDesktopInput').mockImplementation(() => {});

      // Mock the canvas 2D context (happy-dom returns null from getContext).
      const fakeCtx: Record<string, unknown> = {
        clearRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        closePath: vi.fn(),
        stroke: vi.fn(),
        fill: vi.fn(),
      };
      fakeCtx.strokeStyle = '#fff';
      fakeCtx.fillStyle = '#00f';
      fakeCtx.lineWidth = 1;
      fakeCtx.lineJoin = 'round';
      const ctxSpy = vi
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);

      // Stub the animation frame loop deterministically with a BOUNDED queue
      // (the real tick re-arms itself via requestAnimationFrame, so an
      // unbounded while-loop never terminates — drain a fixed number of frames).
      const frameQueue: Array<() => void> = [];
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        if (frameQueue.length === 0) {
          frameQueue.push(() => cb(performance.now()));
        }
        return frameQueue.length;
      });
      vi.stubGlobal('cancelAnimationFrame', () => {});
      const drainFrames = (n: number) => {
        for (let i = 0; i < n && frameQueue.length; i++) {
          frameQueue.shift()!();
        }
      };

      const wrapper = mountWithChrome({
        desktopInputEnabled: true,
        desktopPeerVerified: true,
      });

      // Give the <video> fake dimensions and a bounding box.
      const video = wrapper.find('video');
      const videoEl = video.element as HTMLVideoElement;
      Object.defineProperty(videoEl, 'videoWidth', {
        value: 1920,
        configurable: true,
      });
      Object.defineProperty(videoEl, 'videoHeight', {
        value: 1080,
        configurable: true,
      });
      videoEl.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          width: 1920,
          height: 1080,
          right: 1920,
          bottom: 1080,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;

      // Enable control.
      await wrapper.find('[data-test="desktop-input-toggle"]').trigger('click');
      await flushPromises();
      await nextTick();

      // Drain one frame for the initial mount tick.
      drainFrames(1);

      // Trigger a pointermove to seed the local pointer position.
      await video.trigger('pointermove', { clientX: 100, clientY: 50 });

      // Drain one frame to invoke renderCursorFrame after the pointermove.
      drainFrames(1);

      // Expected canvas-local coords: the video fills the element exactly
      // (no letterbox at this aspect ratio / layout), so contentBox.left = 0,
      // contentBox.top = 0. normalize(100, 50) → x = 100/1920, y = 50/1080.
      // toClient maps back to (100, 50). canvas-local = (100, 50).
      const expectedCx = 100;
      const expectedCy = 50;

      expect(fakeCtx.translate).toHaveBeenCalledWith(expectedCx, expectedCy);
      expect(fakeCtx.stroke).toHaveBeenCalled();
      expect(fakeCtx.fill).toHaveBeenCalled();

      ctxSpy.mockRestore();
    });

    it('draws nothing in the controlling branch before any pointer sample (no crash)', async () => {
      const store = useTerminalStore();
      vi.spyOn(store, 'sendDesktopInput').mockImplementation(() => {});

      const fakeCtx: Record<string, unknown> = {
        clearRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        closePath: vi.fn(),
        stroke: vi.fn(),
        fill: vi.fn(),
      };
      fakeCtx.strokeStyle = '#fff';
      fakeCtx.fillStyle = '#00f';
      fakeCtx.lineWidth = 1;
      fakeCtx.lineJoin = 'round';
      const ctxSpy = vi
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);

      const frameQueue: Array<() => void> = [];
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        if (frameQueue.length === 0) {
          frameQueue.push(() => cb(performance.now()));
        }
        return frameQueue.length;
      });
      vi.stubGlobal('cancelAnimationFrame', () => {});
      const drainFrames = (n: number) => {
        for (let i = 0; i < n && frameQueue.length; i++) {
          frameQueue.shift()!();
        }
      };

      const wrapper = mountWithChrome({
        desktopInputEnabled: true,
        desktopPeerVerified: true,
      });

      const video = wrapper.find('video');
      const videoEl = video.element as HTMLVideoElement;
      Object.defineProperty(videoEl, 'videoWidth', {
        value: 1920,
        configurable: true,
      });
      Object.defineProperty(videoEl, 'videoHeight', {
        value: 1080,
        configurable: true,
      });
      videoEl.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          width: 1920,
          height: 1080,
          right: 1920,
          bottom: 1080,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;

      await wrapper.find('[data-test="desktop-input-toggle"]').trigger('click');
      await flushPromises();
      await nextTick();

      // No pointermove yet → localPointer is null → nothing should be drawn.
      drainFrames(1);

      expect(fakeCtx.translate).not.toHaveBeenCalled();
      expect(fakeCtx.stroke).not.toHaveBeenCalled();

      ctxSpy.mockRestore();
    });
  });

  describe('latency telemetry footer', () => {
    it('surfaces echo latency when desktopEchoMs is defined', async () => {
      const wrapper = mountWithChrome({
        desktopEchoMs: 42,
      });
      const echo = wrapper.find('[data-test="desktop-echo"]');
      expect(echo.exists()).toBe(true);
      expect(echo.text()).toContain('42ms');
      expect(echo.text()).toContain('echo');
    });

    it('does not render echo telemetry when desktopEchoMs is undefined', () => {
      const wrapper = mountWithChrome();
      expect(wrapper.find('[data-test="desktop-echo"]').exists()).toBe(false);
    });

    it('still renders the footer when only echo is available (no sources or stats)', () => {
      const wrapper = mount(DesktopView, {
        props: {
          tab: desktopTab({
            status: 'active',
            desktopEchoMs: 120,
          }),
        },
      });
      expect(wrapper.find('[data-test="desktop-echo"]').exists()).toBe(true);
    });
  });
});

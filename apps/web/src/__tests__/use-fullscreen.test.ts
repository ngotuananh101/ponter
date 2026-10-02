import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, ref, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { useFullscreen } from '@/composables/useFullscreen';

/**
 * happy-dom implements no Fullscreen API, so the tests install a minimal fake
 * that mirrors the parts the composable relies on: the two methods, the
 * `fullscreenElement` property, and the `fullscreenchange` event.
 */
function installFullscreenStub() {
  let current: Element | null = null;
  // A regular function, not an arrow: the composable invokes this method on the
  // target element, so `this` is the only way the stub learns which element went
  // fullscreen. Capturing `this` is the whole point, hence the rule waiver.
  const requestFullscreen = vi.fn(function (this: Element) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    current = this;
    document.dispatchEvent(new Event('fullscreenchange'));
    return Promise.resolve();
  });
  const exitFullscreen = vi.fn(() => {
    current = null;
    document.dispatchEvent(new Event('fullscreenchange'));
    return Promise.resolve();
  });

  // Defined on Element.prototype: the composable calls the method on whatever
  // element it is handed, not on the document element.
  Object.defineProperty(Element.prototype, 'requestFullscreen', {
    configurable: true,
    writable: true,
    value: requestFullscreen,
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    writable: true,
    value: exitFullscreen,
  });
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => current,
  });

  return { requestFullscreen, exitFullscreen };
}

function removeFullscreenStub() {
  for (const [obj, key] of [
    [Element.prototype, 'requestFullscreen'],
    [document, 'exitFullscreen'],
    [document, 'fullscreenElement'],
  ] as const) {
    delete (obj as unknown as Record<string, unknown>)[key as string];
  }
}

/** Mount a throwaway component so `onBeforeUnmount` inside the composable runs. */
function mountWithFullscreen(el: HTMLElement) {
  const target = ref<HTMLElement | null>(el);
  let api!: ReturnType<typeof useFullscreen>;

  const Host = defineComponent({
    setup() {
      api = useFullscreen(target);
      return () => h('div');
    },
  });

  const wrapper = mount(Host, { attachTo: document.body });
  return { wrapper, api, target };
}

describe('useFullscreen', () => {
  beforeEach(() => {
    installFullscreenStub();
  });

  afterEach(() => {
    removeFullscreenStub();
    document.body.innerHTML = '';
  });

  it('reports support when the browser exposes the API', () => {
    const el = document.createElement('div');
    const { wrapper, api } = mountWithFullscreen(el);
    expect(api.isSupported).toBe(true);
    wrapper.unmount();
  });

  it('enters and exits fullscreen, tracking the real document state', async () => {
    const el = document.createElement('div');
    const { wrapper, api } = mountWithFullscreen(el);

    await api.enter();
    expect(document.fullscreenElement).toBe(el);
    expect(api.isFullscreen.value).toBe(true);

    await api.exit();
    expect(document.fullscreenElement).toBeNull();
    expect(api.isFullscreen.value).toBe(false);

    wrapper.unmount();
  });

  it('toggle flips between the two states', async () => {
    const el = document.createElement('div');
    const { wrapper, api } = mountWithFullscreen(el);

    await api.toggle();
    expect(api.isFullscreen.value).toBe(true);
    await api.toggle();
    expect(api.isFullscreen.value).toBe(false);

    wrapper.unmount();
  });

  it('picks up a change the composable did not initiate (Esc key)', async () => {
    const el = document.createElement('div');
    const { wrapper, api } = mountWithFullscreen(el);

    await api.enter();
    expect(api.isFullscreen.value).toBe(true);

    // Simulate the browser dropping fullscreen on its own (Esc / F11).
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => null,
    });
    document.dispatchEvent(new Event('fullscreenchange'));
    await nextTick();

    expect(api.isFullscreen.value).toBe(false);
    wrapper.unmount();
  });

  it('does not leave the browser in fullscreen when the view unmounts', async () => {
    const el = document.createElement('div');
    const { wrapper, api } = mountWithFullscreen(el);

    await api.enter();
    expect(document.fullscreenElement).toBe(el);

    wrapper.unmount();
    await nextTick();

    // Navigating away must not strand the user in a chromeless fullscreen.
    expect(document.fullscreenElement).toBeNull();
  });

  it('swallows a rejected request instead of surfacing an unhandled rejection', async () => {
    const el = document.createElement('div');
    const { wrapper, api } = mountWithFullscreen(el);

    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      configurable: true,
      value: vi.fn(() => Promise.reject(new Error('not allowed'))),
    });

    await expect(api.enter()).resolves.toBeUndefined();
    expect(api.isFullscreen.value).toBe(false);
    wrapper.unmount();
  });
});

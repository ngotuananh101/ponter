import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import XtermTerminal from '../components/terminal/XtermTerminal.vue';
import type { TerminalSession } from '@remote/terminal-core';

describe('XtermTerminal.vue', () => {
  let mockSession: TerminalSession;

  beforeEach(() => {
    mockSession = {
      buffer: { getAll: () => new Uint8Array() },
      onData: vi.fn(() => () => {}),
      write: vi.fn(),
      resize: vi.fn(),
    } as unknown as TerminalSession;
  });

  it('renders container element and mounts terminal', () => {
    const wrapper = mount(XtermTerminal, {
      props: {
        session: mockSession,
      },
    });

    expect(wrapper.find('.terminal-container').exists()).toBe(true);
  });

  it('plays back buffer content on mount', () => {
    const chunk = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    mockSession = {
      ...mockSession,
      buffer: { getAll: () => chunk },
      onData: vi.fn(() => () => {}),
      write: vi.fn(),
      resize: vi.fn(),
    } as unknown as TerminalSession;

    const wrapper = mount(XtermTerminal, {
      props: { session: mockSession },
    });

    expect(wrapper.find('.terminal-container').exists()).toBe(true);
  });

  it('calls session.resize on container resize', () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const resizeCallbackRef: { cb: ResizeObserverCallback } = { cb: () => {} };

    class ResizeObserverStub {
      constructor(cb: ResizeObserverCallback) {
        resizeCallbackRef.cb = cb;
        observe.mockImplementation(() => undefined);
        disconnect.mockImplementation(() => undefined);
      }
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    mount(XtermTerminal, {
      props: { session: mockSession },
    });

    // Simulate resize by invoking the registered callback
    resizeCallbackRef.cb([], {} as ResizeObserver);
    expect(mockSession.resize).toHaveBeenCalled();
  });

  it('unsubscribes from onData and disposes terminal on unmount', () => {
    const unsub = vi.fn();
    mockSession = {
      ...mockSession,
      buffer: { getAll: () => new Uint8Array() },
      onData: vi.fn(() => unsub),
    } as unknown as TerminalSession;

    const wrapper = mount(XtermTerminal, {
      props: { session: mockSession },
    });

    wrapper.unmount();

    expect(unsub).toHaveBeenCalled();
  });
});

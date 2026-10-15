/**
 * Shared test setup for renderer tests.
 *
 * Supplies a typed `window.ponter` mock matching `PonterDesktopApi` so that
 * stores and views can be exercised without the Tauri/Electron bridge. Each
 * test file resets the mock in its own `beforeEach` via `resetPonterMock()`.
 *
 * The global `Window.ponter` type stays as the real `PonterDesktopApi` (declared
 * in `src/shared/ipc-types.ts`) so production code typechecks normally. Test
 * files widen it to `MockedPonterApi` locally via `getPonterMock()`.
 */
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { PonterDesktopApi } from '../../shared/ipc-types';

/**
 * A mocked version of `PonterDesktopApi` where every method is a `vi.Mock`.
 * Test code uses this to call `.mockResolvedValue`, `.mockRejectedValue`, etc.
 */
export type MockedPonterApi = {
  [K in keyof PonterDesktopApi]: Mock;
};

/**
 * The single mock factory. Each method is its own `vi.fn()` so individual tests
 * can re-implement or assert on them.
 */
const ponterMock: MockedPonterApi = {
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  probeServer: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  probeCapture: vi.fn(),
  setAutostart: vi.fn(),
  isAutostartEnabled: vi.fn(),
  listDevices: vi.fn(),
  registerDevice: vi.fn(),
  deleteDevice: vi.fn(),
  getRuntimeStatus: vi.fn(),
  onFleetChanged: vi.fn(),
  onRuntimeStatus: vi.fn(),
};

// Install onto window exactly once per test file import.
if (typeof window !== 'undefined') {
  window.ponter = ponterMock as unknown as PonterDesktopApi;
}

/**
 * Returns the mock cast to `MockedPonterApi` so test code can use
 * `.mockResolvedValue` etc. without type errors.
 */
export function getPonterMock(): MockedPonterApi {
  return window.ponter as unknown as MockedPonterApi;
}

/**
 * Reset every mock fn to a clean state. Call this in each `beforeEach`.
 */
export function resetPonterMock(): MockedPonterApi {
  const m = getPonterMock();
  for (const key of Object.keys(m)) {
    (m as Record<string, Mock>)[key].mockReset();
  }
  return m;
}

/**
 * Set up `onRuntimeStatus` so the returned unsubscribe is callable. Returns an
 * object whose `handler` property is populated when the view calls
 * `onRuntimeStatus` during mount — tests read it after `await flushPromises()`.
 */
export function mockOnRuntimeStatus(): {
  handler: ((status: string) => void) | null;
  unsubscribe: () => void;
} {
  const ctx: { handler: ((status: string) => void) | null } = {
    handler: null,
  };
  const unsubscribe = vi.fn();
  getPonterMock().onRuntimeStatus.mockImplementation(
    (cb: (status: string) => void) => {
      ctx.handler = cb;
      return unsubscribe;
    },
  );
  return {
    get handler() {
      return ctx.handler;
    },
    unsubscribe,
  };
}

/**
 * Set up `onFleetChanged` similarly. Returns an object whose `handler` is
 * populated when the view subscribes.
 */
export function mockOnFleetChanged(): {
  handler: (() => void) | null;
  unsubscribe: () => void;
} {
  const ctx: { handler: (() => void) | null } = { handler: null };
  const unsubscribe = vi.fn();
  getPonterMock().onFleetChanged.mockImplementation((cb: () => void) => {
    ctx.handler = cb;
    return unsubscribe;
  });
  return {
    get handler() {
      return ctx.handler;
    },
    unsubscribe,
  };
}

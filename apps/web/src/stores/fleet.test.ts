import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useFleetStore } from './fleet';
import {
  FakeWebSocket,
  installFakeWebSocket,
  restoreWebSocket,
  lastSocket,
  mockRandomUnit,
} from '@ponter/webrtc-core/test/fake-websocket';

/** Stubbed ticket-mint fetch, mirroring `okTicketFetch` in ws-transport.test.ts. */
const okTicketFetch = vi.fn(
  async () =>
    new Response(JSON.stringify({ ticket: 'tkt_1', expiresIn: 15 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
);

vi.mock('@/services/client', () => ({
  apiClient: {
    http: {
      baseUrl: 'http://test',
      refreshAccessToken: vi.fn(),
    },
  },
}));

vi.mock('@/services/token-storage', () => ({
  tokenStorage: {
    getAccessToken: vi.fn(async () => 'access-token'),
  },
}));

describe('useFleetStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    installFakeWebSocket();
    vi.useFakeTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    // FleetSocket uses `globalThis.fetch` unless overridden; stub it so the
    // ticket mint resolves without a real network call. The factory (defined
    // above) returns a FRESH Response per call so reconnect mints do not reuse
    // a consumed body.
    vi.stubGlobal('fetch', okTicketFetch);
  });

  afterEach(() => {
    restoreWebSocket();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens a socket when the flag is "true" and opens none when "false"', async () => {
    vi.stubEnv('VITE_BROWSER_WS_SIGNALING', 'true');
    const store = useFleetStore();
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // reset for the false case: the first store holds `client`, so a shared
    // Pinia would make store2 early-return at `if (client) return` — bypassing
    // the flag gate entirely and making this half vacuous. Give store2 its own
    // Pinia so start() reaches the flag guard.
    store.stop();
    FakeWebSocket.instances = [];
    vi.stubEnv('VITE_BROWSER_WS_SIGNALING', 'false');
    setActivePinia(createPinia());
    const store2 = useFleetStore();
    store2.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
    store2.stop();
  });

  it('fires the subscribed callback on a {type:"fleet-changed"} frame', async () => {
    vi.stubEnv('VITE_BROWSER_WS_SIGNALING', 'true');
    const store = useFleetStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.start();
    await vi.advanceTimersByTimeAsync(0);

    const socket = lastSocket();
    socket.open();
    // The transport sends subscribe-fleet on open.
    expect(socket.sentFrames()).toContainEqual({ type: 'subscribe-fleet' });

    socket.deliver({ type: 'fleet-changed' });
    // Debounce window must elapse for the callback to fire.
    await vi.advanceTimersByTimeAsync(500);
    expect(cb).toHaveBeenCalledTimes(1);

    store.stop();
  });

  it('debounces two fleet-changed frames inside the window to a single callback', async () => {
    vi.stubEnv('VITE_BROWSER_WS_SIGNALING', 'true');
    const store = useFleetStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.start();
    await vi.advanceTimersByTimeAsync(0);

    const socket = lastSocket();
    socket.open();
    socket.deliver({ type: 'fleet-changed' });
    // second frame well within the debounce window
    socket.deliver({ type: 'fleet-changed' });
    expect(cb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(cb).toHaveBeenCalledTimes(1);

    store.stop();
  });

  it('reconnects on an unexpected server close with the shared backoff; stops after stop()', async () => {
    vi.stubEnv('VITE_BROWSER_WS_SIGNALING', 'true');
    // delay = min(200*2^0, 2000) + round(randomUnit()*100 - 50).
    // "mock jitter to 0" => randomUnit() == 0.5 => jitter 0 => delay 200.
    mockRandomUnit(0.5);
    const store = useFleetStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.start();
    await vi.advanceTimersByTimeAsync(0);

    const socket1 = lastSocket();
    socket1.open();
    // server closes unexpectedly
    socket1.serverClose(1006, 'abnormal');

    // Just before the 200ms backoff fires: no new socket yet.
    await vi.advanceTimersByTimeAsync(199);
    expect(FakeWebSocket.instances).toHaveLength(1);
    // Crossing the threshold schedules the reconnect.
    await vi.advanceTimersByTimeAsync(1);
    // Let the async connect() (awaited ticket mint) flush its microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(lastSocket().url).toBe('ws://test/api/ws/browser?ticket=tkt_1');

    // Now stop: no further sockets even if more time passes.
    store.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('escalates reconnect backoff on repeated failed opens and resets on a successful open', async () => {
    vi.stubEnv('VITE_BROWSER_WS_SIGNALING', 'true');
    // delay = min(200*2^retries, 2000) + round(randomUnit()*100 - 50).
    // "mock jitter to 0" => randomUnit() == 0.5 => jitter 0 => delay is exactly 200*2^retries.
    mockRandomUnit(0.5);
    const store = useFleetStore();
    store.start();
    await vi.advanceTimersByTimeAsync(0);

    // Open socket 1 successfully, then server-close -> first reconnect at 200 ms.
    const socket1 = lastSocket();
    socket1.open();
    socket1.serverClose(1006, 'abnormal');

    // Advance 200 ms (+0 flush) -> socket 2 exists.
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Socket 2 is a FAILED open: server-close WITHOUT calling socket2.open().
    // The backoff should escalate: next reconnect at 200*2^1 = 400 ms.
    const socket2 = lastSocket();
    socket2.serverClose(1006, 'abnormal');

    // At 399 ms after socket 2's close: still only 2 sockets (no socket 3).
    await vi.advanceTimersByTimeAsync(399);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // At 400 ms (+ 0 flush): socket 3 exists — backoff escalated.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // Reset-on-open: socket 3 opens successfully, then server-closes.
    // The next reconnect must be back at 200 ms (retries reset to 0 on open).
    const socket3 = lastSocket();
    socket3.open();
    socket3.serverClose(1006, 'abnormal');

    // Advance 199 ms: still 3 sockets.
    await vi.advanceTimersByTimeAsync(199);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // Advance 1 ms + flush: socket 4 exists — backoff reset to 200.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(4);

    store.stop();
  });

  it('swallows a malformed/unknown frame without throwing and without firing the callback', async () => {
    vi.stubEnv('VITE_BROWSER_WS_SIGNALING', 'true');
    const store = useFleetStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.start();
    await vi.advanceTimersByTimeAsync(0);

    const socket = lastSocket();
    socket.open();
    expect(() => socket.deliverRaw('{ not json')).not.toThrow();
    expect(() => socket.deliverRaw('{"type":"something-else"}')).not.toThrow();
    await vi.advanceTimersByTimeAsync(500);
    expect(cb).not.toHaveBeenCalled();

    store.stop();
  });
});

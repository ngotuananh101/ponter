import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useFleetStore } from './fleet';

/**
 * A minimal fake for the browser `WebSocket` API, mirroring the harness in
 * `packages/webrtc-core/test/ws-transport.test.ts:16-109` so the reconnect
 * state machine can be driven deterministically without a real socket.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  readonly url: string;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Test helper: the socket's `open` event fired. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Test helper: deliver a frame from the server. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Test helper: deliver a raw string (e.g. malformed JSON). */
  deliverRaw(raw: string): void {
    this.onmessage?.({ data: raw });
  }

  /** Test helper: the server closed the socket. */
  serverClose(code = 1006, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** Test helper: frames this socket received, parsed. */
  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;

function installFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
}

function restoreWebSocket(): void {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket =
    ORIGINAL_WEBSOCKET;
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!socket) throw new Error('no WebSocket was opened');
  return socket;
}

/**
 * Pin the store's jitter source to a deterministic value.
 *
 * `randomUnit()` reads one `Uint32Array` word and divides by 2**32, so the
 * mocked word is `value * 2**32`. Mocking the CSPRNG keeps the backoff-delay
 * assertions exact without depending on `Math.random`.
 */
function mockRandomUnit(value: number): void {
  const word = Math.trunc(value * 2 ** 32);
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
    <T extends ArrayBufferView | null>(array: T): T => {
      if (array) (array as unknown as Uint32Array)[0] = word;
      return array;
    },
  );
}

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

    // reset for the false case
    FakeWebSocket.instances = [];
    vi.stubEnv('VITE_BROWSER_WS_SIGNALING', 'false');
    const store2 = useFleetStore();
    store2.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
    store.stop();
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

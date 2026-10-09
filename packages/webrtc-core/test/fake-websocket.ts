import { vi } from 'vitest';

/**
 * A minimal fake for the browser `WebSocket` API.
 *
 * The transport only uses `readyState`, `send`, `close`, `onopen`,
 * `onmessage`, `onclose`, `onerror`, and `close()`'s `code`/`reason`
 * arguments — enough to drive every branch of the reconnect state machine
 * without a real socket.
 */
export class FakeWebSocket {
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

export const ORIGINAL_WEBSOCKET = globalThis.WebSocket;

export function installFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
}

export function restoreWebSocket(): void {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket =
    ORIGINAL_WEBSOCKET;
}

export function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!socket) throw new Error('no WebSocket was opened');
  return socket;
}

/**
 * Pin the store/transport's jitter source to a deterministic value.
 *
 * `randomUnit()` reads one `Uint32Array` word and divides by 2**32, so the
 * mocked word is `value * 2**32`. Mocking the CSPRNG keeps the backoff-delay
 * assertions exact without depending on `Math.random`.
 */
export function mockRandomUnit(value: number): void {
  const word = Math.trunc(value * 2 ** 32);
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
    <T extends ArrayBufferView | null>(array: T): T => {
      if (array) (array as unknown as Uint32Array)[0] = word;
      return array;
    },
  );
}

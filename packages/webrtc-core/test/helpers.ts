import { vi } from 'vitest';
import type { SignalMessage } from '@remote/shared';

export class MemorySignalBus {
  private readonly subscribers: Array<(msg: SignalMessage) => void> = [];

  subscribe(handler: (msg: SignalMessage) => void): () => void {
    this.subscribers.push(handler);
    return () => {
      const idx = this.subscribers.indexOf(handler);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  deliver(msg: SignalMessage): void {
    for (const sub of [...this.subscribers]) {
      sub(msg);
    }
  }
}

export function mockFetchResponse(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

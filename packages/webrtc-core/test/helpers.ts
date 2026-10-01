import { vi } from 'vitest';
import type { SignalMessage } from '@ponter/shared';
import type {
  RTCDataChannelLike,
  RTCPeerConnectionLike,
  SignalTransport,
} from '../src/types';

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

/**
 * A data channel that records nothing and keeps the `readyState` it was built
 * with. It exists for tests that exercise the signaling path, not the channel:
 * a refusal test needs `waitForChannel` to keep waiting (so the refusal is what
 * ends the wait), while a duplicate-delivery test wants the channel to read as
 * usable.
 */
export class FakeChannel implements RTCDataChannelLike {
  constructor(
    readonly label: string,
    readonly readyState: RTCDataChannelLike['readyState'] = 'connecting',
  ) {}

  send(): void {}

  close(): void {}

  onMessage(): void {}

  onStateChange(): void {}
}

export interface ScriptedPeerOptions {
  /**
   * Mirror the real RTCPeerConnection contract: applying a remote answer while
   * already stable is an InvalidStateError. On by default — the tests that
   * redeliver an answer depend on the guard that prevents the second
   * application, and a test that never sends two answers is unaffected.
   */
  enforceStableAnswer?: boolean;
}

/**
 * A peer that answers every description request with a canned one and records
 * what was applied remotely. No ICE, no DTLS: the signaling decisions are the
 * subject, not the transport.
 */
export class ScriptedPeer implements RTCPeerConnectionLike {
  readonly setRemoteCalls: RTCSessionDescriptionInit[] = [];

  constructor(private readonly options: ScriptedPeerOptions = {}) {}

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0-offer' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0-answer' };
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (this.options.enforceStableAnswer !== false) {
      const last = this.setRemoteCalls[this.setRemoteCalls.length - 1];
      if (desc.type === 'answer' && last?.type === 'answer') {
        throw new Error(
          "Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': " +
            'Failed to set remote answer sdp: Called in wrong state: stable',
        );
      }
    }
    this.setRemoteCalls.push(desc);
  }

  async addIceCandidate(): Promise<void> {}

  createDataChannel(label: string): RTCDataChannelLike {
    return new FakeChannel(label);
  }

  onIceCandidate(): void {}

  onDataChannel(): void {}

  onConnectionStateChange(): void {}

  async getStats(): Promise<RTCStatsReport> {
    return {} as unknown as RTCStatsReport;
  }

  async close(): Promise<void> {}
}

export interface StubTransport {
  transport: SignalTransport;
  sent: SignalMessage[];
  deliver: (m: SignalMessage) => void;
}

/**
 * A transport under test control: `send` records into `sent` instead of hitting
 * the network, and `deliver` pushes a message straight into whatever
 * `PeerConnection` subscribed to.
 */
export function stubTransport(): StubTransport {
  const sent: SignalMessage[] = [];
  let handler: ((m: SignalMessage) => void) | null = null;
  const transport: SignalTransport = {
    send: async (m) => {
      sent.push(m);
    },
    subscribe: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    close: () => {},
  };
  return { transport, sent, deliver: (m) => handler?.(m) };
}

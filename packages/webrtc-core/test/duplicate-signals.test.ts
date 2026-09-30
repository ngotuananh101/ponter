import { describe, it, expect, vi } from 'vitest';
import { RESTPollingTransport } from '../src/transport';
import { PeerConnection } from '../src/connection';
import type {
  RTCPeerConnectionLike,
  RTCDataChannelLike,
  SignalTransport,
} from '../src/types';
import type { SignalMessage } from '@ponter/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function answerPayload(sdp: string): unknown {
  return {
    signals: [
      {
        id: 'sig_1',
        sessionId: 'sess_1',
        type: 'answer',
        payload: { sessionId: 'sess_1', sdp, approved: true },
      },
    ],
    cursor: 'sig_1',
  };
}

describe('overlapping polls never deliver the same signal twice', () => {
  it('does not start a second poll while one is in flight', async () => {
    const pollResolvers: Array<(r: Response) => void> = [];
    let pollCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/signal/poll')) {
        pollCalls += 1;
        return new Promise<Response>((resolve) => {
          pollResolvers.push(resolve);
        });
      }
      return new Response(JSON.stringify({ id: 'sig_0' }), { status: 201 });
    });

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 't',
      fetch: fetchMock as unknown as typeof fetch,
      initialIntervalMs: 20,
      maxIntervalMs: 100,
    });
    const received: SignalMessage[] = [];
    transport.subscribe((m) => received.push(m));

    await sleep(50);
    expect(pollCalls).toBe(1);

    // A trickled ICE candidate completes send() -> reschedule(0) while the
    // first poll is still awaiting its response.
    await transport.send({
      type: 'ice-candidate',
      data: {
        sessionId: 'sess_1',
        candidate: 'cand',
        sdpMid: null,
        sdpMLineIndex: null,
      },
    });
    await sleep(30);

    // Without an in-flight guard a second poll starts here with the same
    // cursor, and the answer row below is delivered twice.
    expect(pollCalls).toBe(1);

    for (const resolve of pollResolvers) {
      resolve(
        new Response(JSON.stringify(answerPayload('v=0-answer')), {
          status: 200,
        }),
      );
    }
    await sleep(50);
    expect(received.filter((m) => m.type === 'answer')).toHaveLength(1);

    transport.close();
  });
});

class FakeChannel implements RTCDataChannelLike {
  readonly readyState = 'open' as const;

  constructor(readonly label: string) {}

  send(): void {}

  close(): void {}

  onMessage(): void {}

  onStateChange(): void {}
}

class ScriptedPeer implements RTCPeerConnectionLike {
  readonly setRemoteCalls: RTCSessionDescriptionInit[] = [];

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0-offer' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0-answer' };
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(
    desc: RTCSessionDescriptionInit,
  ): Promise<void> {
    // Mirror the real RTCPeerConnection contract: applying a remote answer
    // while already stable is an InvalidStateError.
    const last = this.setRemoteCalls[this.setRemoteCalls.length - 1];
    if (desc.type === 'answer' && last?.type === 'answer') {
      throw new Error(
        "Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': " +
          'Failed to set remote answer sdp: Called in wrong state: stable',
      );
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

function stubTransport(): {
  transport: SignalTransport;
  sent: SignalMessage[];
  deliver: (m: SignalMessage) => void;
} {
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

describe('duplicate signals under at-least-once delivery', () => {
  it('ignores a redelivered answer instead of throwing InvalidStateError', async () => {
    const errorLines: string[] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        errorLines.push(args.map(String).join(' '));
      });
    try {
      const peer = new ScriptedPeer();
      const { transport, deliver } = stubTransport();
      const pc = new PeerConnection(peer, transport, {
        role: 'offerer',
        channelLabels: ['terminal'],
      });

      const answer: SignalMessage = {
        type: 'answer',
        data: { sessionId: 'sess_1', sdp: 'v=0-answer', approved: true },
      };
      deliver(answer);
      await sleep(20);
      // Same DB row polled twice (overlapping polls, or a retry).
      deliver(answer);
      await sleep(20);

      expect(
        peer.setRemoteCalls.filter((d) => d.type === 'answer'),
      ).toHaveLength(1);
      expect(errorLines.join('\n')).not.toContain('failed to handle signal');

      await pc.close();
    } finally {
      spy.mockRestore();
    }
  });

  it('answers a redelivered offer only once', async () => {
    const peer = new ScriptedPeer();
    const { transport, sent, deliver } = stubTransport();
    const pc = new PeerConnection(peer, transport, {
      role: 'answerer',
      channelLabels: [],
    });

    const offer: SignalMessage = {
      type: 'offer',
      data: {
        sessionId: 'sess_1',
        sdp: 'v=0-offer',
        capabilities: ['terminal'],
      },
    };
    deliver(offer);
    await sleep(20);
    deliver(offer);
    await sleep(20);

    expect(sent.filter((m) => m.type === 'answer')).toHaveLength(1);

    await pc.close();
  });
});

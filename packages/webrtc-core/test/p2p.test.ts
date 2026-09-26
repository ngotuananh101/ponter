import { describe, it, expect, afterEach, vi } from 'vitest';
import { WeriftAdapter } from '../src/adapters/werift';
import { PeerConnection, MAX_PENDING_CANDIDATES } from '../src/connection';
import type {
  RTCPeerConnectionLike,
  RTCDataChannelLike,
  SignalTransport,
} from '../src/types';
import type { SignalMessage } from '@remote/shared';

// Direct in-memory bus connecting offerer and answerer transports
class InProcessBus {
  private handlers = new Map<string, Array<(msg: SignalMessage) => void>>();

  createTransport(id: string, targetId: string): SignalTransport {
    if (!this.handlers.has(id)) {
      this.handlers.set(id, []);
    }

    return {
      send: async (msg: SignalMessage) => {
        const targetList = this.handlers.get(targetId) ?? [];
        for (const handler of [...targetList]) {
          handler(msg);
        }
      },
      subscribe: (handler: (msg: SignalMessage) => void) => {
        const list = this.handlers.get(id) ?? [];
        list.push(handler);
        this.handlers.set(id, list);
        return () => {
          const idx = list.indexOf(handler);
          if (idx >= 0) list.splice(idx, 1);
        };
      },
      close: () => {
        this.handlers.delete(id);
      },
    };
  }

  /**
   * Deliver a signal to a named transport without going through a sender.
   * Used to drive the answerer with candidates whose offer never arrives.
   */
  deliverTo(id: string, msg: SignalMessage): void {
    for (const handler of [...(this.handlers.get(id) ?? [])]) {
      handler(msg);
    }
  }
}

/**
 * Wraps a real adapter and records the ordering guarantee F1 exists to provide:
 * `addIceCandidate` must never be called before `setRemoteDescription`. The
 * answerer's candidates all arrive before its remote description is set (werift
 * emits them during `createOffer()` on the offerer, ahead of the offer being
 * sent), so without the F1 buffer every one of these calls lands too early.
 */
class OrderRecorder implements RTCPeerConnectionLike {
  public remoteDescriptionSet = false;
  public violations = 0;
  public addIceCandidateCalls = 0;

  constructor(private readonly inner: RTCPeerConnectionLike) {}

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return await this.inner.createOffer();
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return await this.inner.createAnswer();
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    await this.inner.setLocalDescription(description);
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    await this.inner.setRemoteDescription(description);
    this.remoteDescriptionSet = true;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addIceCandidateCalls += 1;
    if (!this.remoteDescriptionSet) {
      this.violations += 1;
    }
    await this.inner.addIceCandidate(candidate);
  }

  createDataChannel(
    label: string,
    options?: RTCDataChannelInit,
  ): RTCDataChannelLike {
    return this.inner.createDataChannel(label, options);
  }

  onIceCandidate(handler: (candidate: RTCIceCandidateInit) => void): void {
    this.inner.onIceCandidate(handler);
  }

  onDataChannel(handler: (channel: RTCDataChannelLike) => void): void {
    this.inner.onDataChannel(handler);
  }

  onConnectionStateChange(handler: (state: string) => void): void {
    this.inner.onConnectionStateChange(handler);
  }

  async getStats(): Promise<RTCStatsReport> {
    return await this.inner.getStats();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

describe('Real P2P Handshake (werift)', () => {
  let offererPC: PeerConnection | null = null;
  let answererPC: PeerConnection | null = null;

  afterEach(async () => {
    if (offererPC) {
      await offererPC.close();
      offererPC = null;
    }
    if (answererPC) {
      await answererPC.close();
      answererPC = null;
    }
  });

  it('completes real ICE + DTLS + SCTP handshake on loopback without external STUN', async () => {
    const bus = new InProcessBus();
    const tA = bus.createTransport('A', 'B');
    const tB = bus.createTransport('B', 'A');

    const adapterA = new WeriftAdapter({ iceServers: [] });
    const adapterB = new WeriftAdapter({ iceServers: [] });

    offererPC = new PeerConnection(adapterA, tA, {
      role: 'offerer',
      channelLabels: ['terminal', 'control'],
    });

    answererPC = new PeerConnection(adapterB, tB, {
      role: 'answerer',
      channelLabels: [],
    });

    // Start handshake
    await offererPC.start();

    // Wait for channel 'terminal' to open on both sides
    const chA = await offererPC.waitForChannel('terminal', 12000);
    const chB = await answererPC.waitForChannel('terminal', 12000);

    expect(chA.readyState).toBe('open');
    expect(chB.readyState).toBe('open');

    // Verify bidirectional data transfer
    let receivedTypeA: string | null = null;
    let receivedTypeB: string | null = null;
    const echoPromise = new Promise<string>((resolve) => {
      chA.onMessage((data) => {
        receivedTypeA = typeof data;
        const text =
          typeof data === 'string' ? data : Buffer.from(data).toString();
        resolve(text);
      });
    });

    chB.onMessage((data) => {
      receivedTypeB = typeof data;
      const text =
        typeof data === 'string' ? data : Buffer.from(data).toString();
      chB.send(`echo:${text}`);
    });

    chA.send('ping-p2p');
    const echo = await echoPromise;

    expect(echo).toBe('echo:ping-p2p');
    expect(receivedTypeA).toBe('string');
    expect(receivedTypeB).toBe('string');

    // Verify stats return RTCStatsReport
    const statsA = await offererPC.getStats();
    expect(statsA).toBeDefined();
    expect(typeof statsA.size).toBe('number');
  }, 20000);

  it('buffers ICE candidates received before remote description is set (F1)', async () => {
    const bus = new InProcessBus();
    const tA = bus.createTransport('A', 'B');
    const tB = bus.createTransport('B', 'A');

    const adapterA = new WeriftAdapter({ iceServers: [] });
    const recorder = new OrderRecorder(new WeriftAdapter({ iceServers: [] }));

    offererPC = new PeerConnection(adapterA, tA, {
      role: 'offerer',
      channelLabels: ['terminal'],
    });

    answererPC = new PeerConnection(recorder, tB, {
      role: 'answerer',
      channelLabels: [],
    });

    await offererPC.start();

    const ch = await answererPC.waitForChannel('terminal', 12000);
    expect(ch.readyState).toBe('open');

    // The handshake succeeding is not evidence of F1: werift tolerates a
    // candidate added with no remote description (it is recorded and never
    // resolves), so the connection still opens. Assert the ordering guarantee
    // itself. Vacuity guard first: if no candidate ever reached the answerer
    // the violations count below would be trivially zero.
    expect(recorder.addIceCandidateCalls).toBeGreaterThan(0);
    expect(recorder.violations).toBe(0);
  }, 20000);

  it('creates configured data channels before offer so SCTP is in SDP (F2)', async () => {
    const bus = new InProcessBus();
    const tA = bus.createTransport('A', 'B');
    const tB = bus.createTransport('B', 'A');

    const adapterA = new WeriftAdapter({ iceServers: [] });
    const adapterB = new WeriftAdapter({ iceServers: [] });

    offererPC = new PeerConnection(adapterA, tA, {
      role: 'offerer',
      channelLabels: ['desktop', 'files'],
    });

    answererPC = new PeerConnection(adapterB, tB, {
      role: 'answerer',
      channelLabels: [],
    });

    await offererPC.start();

    const chDesktop = await answererPC.waitForChannel('desktop', 12000);
    const chFiles = await answererPC.waitForChannel('files', 12000);

    expect(chDesktop.label).toBe('desktop');
    expect(chFiles.label).toBe('files');
  }, 20000);

  it('exposes connection state change events', async () => {
    const bus = new InProcessBus();
    const tA = bus.createTransport('A', 'B');
    const tB = bus.createTransport('B', 'A');

    const adapterA = new WeriftAdapter({ iceServers: [] });
    const adapterB = new WeriftAdapter({ iceServers: [] });

    offererPC = new PeerConnection(adapterA, tA, {
      role: 'offerer',
      channelLabels: ['control'],
    });

    answererPC = new PeerConnection(adapterB, tB, {
      role: 'answerer',
      channelLabels: [],
    });

    const statesA: string[] = [];
    offererPC.onConnectionStateChange((state) => statesA.push(state));

    await offererPC.start();
    await offererPC.waitForChannel('control', 12000);

    // Spec §7: "The P2P test must assert a real `connected` state, not merely
    // that no error was thrown." werift emits connecting → connected, and a
    // channel cannot open before DTLS/SCTP complete, so `connected` is always
    // present here.
    expect(statesA).toContain('connected');
  }, 20000);

  it('times out waitForChannel when peer does not respond', async () => {
    const bus = new InProcessBus();
    const tA = bus.createTransport('A', 'B');

    const adapterA = new WeriftAdapter({ iceServers: [] });
    offererPC = new PeerConnection(adapterA, tA, {
      role: 'offerer',
      channelLabels: ['terminal'],
    });

    await expect(offererPC.waitForChannel('non_existent', 300)).rejects.toThrow(
      'timeout waiting for channel "non_existent"',
    );
  });

  it('bounds the pending ICE candidate buffer before remote description (R32)', async () => {
    // R32: src/connection.ts:22 is unbounded. This drives the answerer with a
    // hand-rolled transport that never delivers an offer, so nothing ever sets
    // the remote description and every candidate is buffered.
    const bus = new InProcessBus();
    const tB = bus.createTransport('B', 'A');

    const adapterB = new WeriftAdapter({ iceServers: [] });
    answererPC = new PeerConnection(adapterB, tB, {
      role: 'answerer',
      channelLabels: [],
    });

    for (let i = 0; i < MAX_PENDING_CANDIDATES + 20; i += 1) {
      bus.deliverTo('B', {
        type: 'ice-candidate',
        data: {
          sessionId: 'sess_1',
          candidate: `candidate:${i} 1 UDP 2130706431 192.168.1.1 ${50000 + i} typ host`,
          sdpMid: null,
          sdpMLineIndex: null,
        },
      });
      // handleSignal is dispatched through a void'd promise chain; yield so the
      // buffer actually receives each candidate before the next one is sent.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(answererPC.pendingCandidateCount).toBeLessThanOrEqual(
      MAX_PENDING_CANDIDATES,
    );
  }, 20000);

  it('flushes the remaining candidates when one is rejected (R32)', async () => {
    // R32: src/connection.ts:170 splices the whole buffer out before the first
    // await, so a rejection on candidate 2 of 3 discards candidate 3 — it is
    // neither added nor still queued.
    const bus = new InProcessBus();
    const tB = bus.createTransport('B', 'A');

    const added: string[] = [];
    let remoteSet = false;

    const inner = new WeriftAdapter({ iceServers: [] });
    const recorder: RTCPeerConnectionLike = {
      createOffer: () => inner.createOffer(),
      createAnswer: () => inner.createAnswer(),
      setLocalDescription: (d) => inner.setLocalDescription(d),
      setRemoteDescription: async (d) => {
        await inner.setRemoteDescription(d);
        remoteSet = true;
      },
      addIceCandidate: async (c) => {
        added.push(c.candidate ?? '');
        if (c.candidate?.includes('cand_2')) {
          throw new Error('bad candidate');
        }
        await inner.addIceCandidate(c);
      },
      createDataChannel: (label, options) =>
        inner.createDataChannel(label, options),
      onIceCandidate: (handler) => inner.onIceCandidate(handler),
      onDataChannel: (handler) => inner.onDataChannel(handler),
      onConnectionStateChange: (handler) =>
        inner.onConnectionStateChange(handler),
      getStats: () => inner.getStats(),
      close: () => inner.close(),
    };

    answererPC = new PeerConnection(recorder, tB, {
      role: 'answerer',
      channelLabels: [],
    });

    for (const name of ['cand_1', 'cand_2', 'cand_3']) {
      bus.deliverTo('B', {
        type: 'ice-candidate',
        data: {
          sessionId: 'sess_1',
          candidate: name,
          sdpMid: null,
          sdpMLineIndex: null,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Deliver an offer so the answerer sets its remote description and flushes.
    // The offer is real enough to parse; werift's setRemoteDescription is the
    // only part that has to succeed, and the answer it produces is discarded.
    const offererAdapter = new WeriftAdapter({ iceServers: [] });
    const tA = bus.createTransport('A', 'B');
    offererPC = new PeerConnection(offererAdapter, tA, {
      role: 'offerer',
      channelLabels: ['terminal'],
    });
    const offer = await offererAdapter.createOffer();
    bus.deliverTo('B', {
      type: 'offer',
      data: {
        sessionId: 'sess_1',
        sdp: offer.sdp ?? '',
        capabilities: ['terminal'],
      },
    });

    await vi.waitFor(() => expect(remoteSet).toBe(true));
    await vi.waitFor(() => expect(added).toHaveLength(3));

    // cand_2 threw, and cand_3 was still attempted: the tail was not dropped.
    expect(added).toEqual(['cand_1', 'cand_2', 'cand_3']);
  }, 20000);
});

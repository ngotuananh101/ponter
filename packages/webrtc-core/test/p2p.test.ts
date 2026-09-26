import { describe, it, expect, afterEach } from 'vitest';
import { WeriftAdapter } from '../src/adapters/werift';
import { PeerConnection } from '../src/connection';
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
});

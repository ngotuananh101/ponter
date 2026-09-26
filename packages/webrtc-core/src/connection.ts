import type {
  RTCPeerConnectionLike,
  RTCDataChannelLike,
  SignalTransport,
  PeerConnectionOptions,
} from './types';
import type { SignalMessage } from '@remote/shared';
import { DataChannelManager } from './data-channel';
import {
  toSessionDescriptionInit,
  toIceCandidateInit,
  createOfferSignal,
  createAnswerSignal,
  createCandidateSignal,
} from './signal-handler';

/**
 * Hard cap on ICE candidates buffered before the remote description is set.
 *
 * The buffer exists because `addIceCandidate` before `setRemoteDescription`
 * is a protocol error (Week 4 F1). A peer that trickles candidates while never
 * sending an offer would otherwise grow it without limit — the candidate count
 * is attacker-influenced, and each entry is a small object retained for the
 * life of the connection.
 *
 * 64 is chosen against the real shape of a loopback/single-STUN exchange: a
 * browser emits a handful of host candidates plus one per STUN server, so 64 is
 * far above any honest handshake and far below a useful memory-exhaustion
 * vector. When the cap is reached the oldest entry is dropped rather than the
 * newest: an ICE agent retries connectivity checks against its full candidate
 * set, so a stale candidate is the cheaper one to lose.
 */
export const MAX_PENDING_CANDIDATES = 64;

export class PeerConnection {
  public readonly dataChannels = new DataChannelManager();

  private remoteDescriptionSet = false;
  private isClosed = false;
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];

  /**
   * Read-only view of the pre-remote-description candidate buffer, for tests
   * and diagnostics. The buffer is a private detail; its *size* is not.
   */
  get pendingCandidateCount(): number {
    return this.pendingCandidates.length;
  }

  private readonly stateListeners: Array<(state: string) => void> = [];
  private readonly unsubscribeTransport: () => void;

  constructor(
    public readonly peer: RTCPeerConnectionLike,
    public readonly transport: SignalTransport,
    public readonly options: PeerConnectionOptions,
  ) {
    // 1. Hook peer candidates and send via transport
    this.peer.onIceCandidate((candidate) => {
      if (this.isClosed) return;
      const msg = createCandidateSignal('', candidate);
      // Fire-and-forget: a candidate arriving as the transport closes must not
      // surface as an unhandled rejection, which would terminate a Node host.
      void this.transport.send(msg).catch((error: unknown) => {
        console.error('[PeerConnection] failed to send ICE candidate', error);
      });
    });

    // 2. Hook incoming remote data channels
    this.peer.onDataChannel((channel) => {
      this.dataChannels.registerChannel(channel);
    });

    // 3. Hook peer connection state changes
    this.peer.onConnectionStateChange((state) => {
      for (const listener of [...this.stateListeners]) {
        listener(state);
      }
    });

    // 4. Pre-create all offerer data channels before offer creation (F2)
    if (options.role === 'offerer') {
      for (const label of options.channelLabels) {
        const dc = this.peer.createDataChannel(label, { ordered: true });
        this.dataChannels.registerChannel(dc);
      }
    }

    // 5. Subscribe to incoming signaling messages
    this.unsubscribeTransport = this.transport.subscribe((msg) => {
      // Signal payloads are attacker-controlled (spec §7), so a malformed one
      // throws inside `handleSignal`. Swallow the rejection here: an unhandled
      // rejection terminates the process in Node and masks the real signal.
      void this.handleSignal(msg).catch((error: unknown) => {
        console.error('[PeerConnection] failed to handle signal', error);
      });
    });
  }

  async start(): Promise<void> {
    if (this.isClosed) throw new Error('PeerConnection is closed');
    if (this.options.role !== 'offerer') return;

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    const signal = createOfferSignal('', offer, this.options.channelLabels);
    await this.transport.send(signal);
  }

  onConnectionStateChange(handler: (state: string) => void): () => void {
    this.stateListeners.push(handler);
    return () => {
      const idx = this.stateListeners.indexOf(handler);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  async waitForChannel(
    label: string,
    timeoutMs = 10000,
  ): Promise<RTCDataChannelLike> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ch = this.dataChannels.getChannel(label);
      if (ch && ch.readyState === 'open') {
        return ch;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timeout waiting for channel "${label}" (saw state: ${ch ? ch.readyState : 'not registered'})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }

  async getStats(): Promise<RTCStatsReport> {
    return await this.peer.getStats();
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    this.unsubscribeTransport();
    this.transport.close();
    this.dataChannels.closeAll();
    this.pendingCandidates.length = 0;
    await this.peer.close();
  }

  private async handleSignal(msg: SignalMessage): Promise<void> {
    if (this.isClosed) return;

    switch (msg.type) {
      case 'ice-candidate': {
        const candInit = toIceCandidateInit(msg.data);
        if (this.remoteDescriptionSet) {
          await this.peer.addIceCandidate(candInit);
        } else {
          // F1 ICE candidate buffering, bounded (R32).
          if (this.pendingCandidates.length >= MAX_PENDING_CANDIDATES) {
            this.pendingCandidates.shift();
          }
          this.pendingCandidates.push(candInit);
        }
        break;
      }

      case 'offer': {
        if (this.options.role !== 'answerer') return;
        const offerDesc = toSessionDescriptionInit(msg.data, 'offer');
        await this.peer.setRemoteDescription(offerDesc);
        this.remoteDescriptionSet = true;
        await this.flushPendingCandidates();

        const answer = await this.peer.createAnswer();
        await this.peer.setLocalDescription(answer);
        const answerSignal = createAnswerSignal(
          msg.data.sessionId,
          answer,
          true,
        );
        await this.transport.send(answerSignal);
        break;
      }

      case 'answer': {
        if (this.options.role !== 'offerer') return;
        const answerDesc = toSessionDescriptionInit(msg.data, 'answer');
        await this.peer.setRemoteDescription(answerDesc);
        this.remoteDescriptionSet = true;
        await this.flushPendingCandidates();
        break;
      }
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    const queued = this.pendingCandidates.splice(0);
    for (const cand of queued) {
      try {
        await this.peer.addIceCandidate(cand);
      } catch (error: unknown) {
        // R32: one bad candidate must not discard the rest. The buffer was
        // already emptied by splice(), so a bare `await` in the loop would
        // leave every later candidate neither added nor queued. ICE recovers
        // from a missing candidate as long as one pair succeeds, so dropping
        // one and keeping the others is strictly better than dropping the tail.
        console.error('[PeerConnection] failed to add ICE candidate', error);
      }
    }
  }
}

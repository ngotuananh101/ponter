import type {
  RTCPeerConnectionLike,
  RTCDataChannelLike,
  SignalTransport,
  PeerConnectionOptions,
  MediaStreamLike,
  MediaStreamTrackLike,
} from './types';
import {
  canonicalProofMessage,
  parseSdpFingerprint,
  normalizeFingerprint,
} from '@ponter/shared';
import type { SignalMessage, IdentityProof } from '@ponter/shared';
import { DataChannelManager } from './data-channel';
import { configureReceiveMedia, subscribeRemoteTracks } from './media-channel';
import {
  toSessionDescriptionInit,
  toIceCandidateInit,
  createOfferSignal,
  createAnswerSignal,
  createCandidateSignal,
} from './signal-handler';

/** SHA-256 of a UTF-8 string, returned as lowercase hex. */
async function sha256HexUtf8(message: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

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

/**
 * How long `close()` waits for data channels to acknowledge their SCTP stream
 * reset (RFC 6525) before tearing the transport down anyway.
 *
 * The acknowledgement is a round trip, and a lost reset is retransmitted on
 * the SCTP RTO (3s), so 5s covers one loss on a healthy link. Waiting longer
 * only delays teardown against a peer that is already gone.
 */
export const CHANNEL_CLOSE_TIMEOUT_MS = 5000;

export class PeerConnection {
  public readonly dataChannels = new DataChannelManager();

  private remoteDescriptionSet = false;
  private isClosed = false;
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  /** Capabilities advertised by the remote peer in its last answer/offer. */
  private remoteCapabilities: string[] = [];
  /**
   * Whether the handshake description has been applied in each direction.
   *
   * Signaling delivery is at-least-once (ADR-03), so a poll can redeliver the
   * same row: `handleSignal` must tolerate a second, identical offer or
   * answer. An answerer answers each distinct offer once and drops repeats —
   * a repeat would rebuild the local description and POST a second answer —
   * while an offerer drops a second answer outright. Without the guard the
   * browser throws `InvalidStateError: Called in wrong state: stable`, which
   * is the error this exists to prevent.
   */
  private offerApplied = false;
  private answerApplied = false;

  /**
   * Why the agent declined this connection, when it did.
   *
   * ADR-14: one session per agent. A second concurrent offer is answered with
   * `approved: false` and a real SDP. The SDP must NOT be applied — the agent
   * is about to close that peer connection, and applying it flips this side to
   * `stable`, so the next retry fails as a signaling-state error instead of
   * reading as a refusal. The flag is surfaced from `waitForChannel` instead,
   * where the user's tab is actually waiting.
   */
  private refusalReason: string | null = null;

  /**
   * Read-only view of the pre-remote-description candidate buffer, for tests
   * and diagnostics. The buffer is a private detail; its *size* is not.
   */
  get pendingCandidateCount(): number {
    return this.pendingCandidates.length;
  }

  /**
   * Capabilities the remote peer advertised in its answer (WS1 `e2ee`, etc.).
   * Empty when the remote sent none — the plaintext path then stays byte-identical.
   */
  getRemoteCapabilities(): string[] {
    return this.remoteCapabilities;
  }

  private readonly stateListeners: Array<(state: string) => void> = [];
  private readonly trackListeners: Array<
    (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void
  > = [];
  private readonly unsubscribeTransport: () => void;

  constructor(
    public readonly peer: RTCPeerConnectionLike,
    public readonly transport: SignalTransport,
    public readonly options: PeerConnectionOptions,
  ) {
    // 1. Hook peer candidates and send via transport
    this.peer.onIceCandidate((candidate) => {
      if (this.isClosed) return;
      const msg = createCandidateSignal(this.options.sessionId, candidate);
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

    // 3b. Hook remote media tracks when the adapter supports them. The guard
    // keeps every existing mock (which has no onTrack) working untouched.
    if (this.peer.onTrack) {
      subscribeRemoteTracks(this.peer, (track, streams) => {
        for (const listener of this.trackListeners.slice()) {
          listener(track, streams);
        }
      });
    }

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

    // Fail fast BEFORE the offer is created: an adapter that cannot deliver
    // tracks would otherwise produce a stream that silently never arrives.
    if (this.options.media?.video) {
      if (!this.peer.addTransceiver || !this.peer.onTrack) {
        throw new Error(
          'media.video was requested but this adapter does not implement the media seam (addTransceiver/onTrack)',
        );
      }
      configureReceiveMedia(this.peer, this.options.media);
    }

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    const capabilities =
      this.options.capabilities ?? this.options.channelLabels;

    let proof: IdentityProof | undefined;
    if (this.options.identity) {
      const fingerprint = parseSdpFingerprint(offer.sdp ?? '');
      const sdpSha256Hex = await sha256HexUtf8(offer.sdp ?? '');
      const message = canonicalProofMessage({
        role: this.options.identity.role,
        sessionId: this.options.sessionId,
        sdpSha256Hex,
        fingerprint,
      });
      proof = {
        signature: await this.options.identity.sign(message),
        fingerprint,
      };
    }

    const signal = createOfferSignal(
      this.options.sessionId,
      offer,
      capabilities,
      proof,
      this.options.identity?.userSigningPublicKey,
    );
    await this.transport.send(signal);
  }

  onConnectionStateChange(handler: (state: string) => void): () => void {
    this.stateListeners.push(handler);
    return () => {
      const idx = this.stateListeners.indexOf(handler);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  onRemoteTrack(
    handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void,
  ): () => void {
    this.trackListeners.push(handler);
    return () => {
      const idx = this.trackListeners.indexOf(handler);
      if (idx >= 0) this.trackListeners.splice(idx, 1);
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
      // Fail fast on a refusal: the channel will never open, so waiting out
      // the timeout would only delay a decision already made — and say
      // "timeout ... (saw state: connecting)", which names neither the
      // refusal nor its cause.
      if (this.refusalReason) {
        throw new Error(this.refusalReason);
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

    // Closing a data channel starts the SCTP stream reset (RFC 6525) — and
    // for the Rust agent, receiving that reset is what ends its session. The
    // reset leaves asynchronously, so stopping the transport right away raced
    // it: when `peer.close()` closed ICE first, `ice.send()` dropped the
    // reset silently and the agent saw nothing until ICE itself failed ~30s
    // later. Wait (bounded) for the reset to be acknowledged before stopping
    // the transport; `peer.close()` stays the fallback for a peer that is
    // already gone.
    const closing = this.dataChannels.all();
    this.dataChannels.closeAll();
    this.pendingCandidates.length = 0;
    await this.awaitChannelsClosed(closing);

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
        if (this.offerApplied) return;
        this.offerApplied = true;
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
          undefined,
          msg.data.capabilities ?? [],
        );
        await this.transport.send(answerSignal);
        break;
      }

      case 'answer': {
        if (this.options.role !== 'offerer') return;
        if (this.answerApplied) return;
        this.answerApplied = true;

        // Record the remote's advertised capabilities (WS1 `e2ee`, etc.) so
        // the offerer can gate negotiation on it. Absent → empty, and the
        // plaintext path stays byte-identical.
        this.remoteCapabilities = msg.data.capabilities ?? [];

        // A refusal is a real answer carrying `approved: false` (ADR-14: one
        // session per agent). It must not be applied: the agent is about to
        // close that peer connection, and setting the refusal SDP as remote
        // would flip this side to `stable` — so a retry on the same
        // PeerConnection would fail as `InvalidStateError` instead of reading
        // as a refusal. Record why and let `waitForChannel` fail fast.
        if (msg.data.approved === false) {
          this.refusalReason =
            'the agent refused the connection (one session per agent; another session is already active)';
          return;
        }

        const answerDesc = toSessionDescriptionInit(msg.data, 'answer');

        if (this.options.identity) {
          const ok = await this.verifyRemoteProof(
            'answerer',
            msg.data.sessionId,
            answerDesc.sdp ?? '',
            msg.data.proof,
          );
          if (!ok) {
            this.refusalReason =
              'the agent answer failed peer-identity verification';
            return; // do NOT setRemoteDescription
          }
        }

        await this.peer.setRemoteDescription(answerDesc);
        this.remoteDescriptionSet = true;
        await this.flushPendingCandidates();
        break;
      }
    }
  }

  /**
   * Verify the remote peer's WS2 identity proof over its SDP.
   *
   * Returns `false` when `proof` is absent (fail-closed) or when any check
   * throws — the caller must treat `false` as "do not apply the description".
   */
  private async verifyRemoteProof(
    role: 'offerer' | 'answerer',
    sessionId: string,
    sdp: string,
    proof?: IdentityProof,
  ): Promise<boolean> {
    if (!proof) return false;
    try {
      const fingerprint = parseSdpFingerprint(sdp);
      const sdpSha256Hex = await sha256HexUtf8(sdp);
      const message = canonicalProofMessage({
        role,
        sessionId,
        sdpSha256Hex,
        fingerprint,
      });
      const sigOk = await this.options.identity!.verifyPeer(
        message,
        proof.signature,
      );
      return sigOk && normalizeFingerprint(proof.fingerprint) === fingerprint;
    } catch {
      return false;
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

  /**
   * Wait (bounded) for channels to finish the SCTP closing handshake.
   *
   * A channel only reaches `closed` once the remote acknowledges the stream
   * reset — the same event by which the remote learns the session is over —
   * so this is the deterministic point past which the reset has arrived.
   * When the bound expires the transport is torn down anyway: the peer is
   * gone and has nothing left to acknowledge with.
   */
  private async awaitChannelsClosed(
    channels: RTCDataChannelLike[],
  ): Promise<void> {
    const deadline = Date.now() + CHANNEL_CLOSE_TIMEOUT_MS;
    while (channels.some((channel) => channel.readyState !== 'closed')) {
      if (Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
}

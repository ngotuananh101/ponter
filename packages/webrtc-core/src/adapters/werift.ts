import {
  RTCPeerConnection as WeriftPC,
  MediaStream as WeriftMediaStream,
  MediaStreamTrack as WeriftMediaStreamTrack,
} from 'werift';
import type { RTCRtpCodecParameters, TransceiverOptions } from 'werift';
import type {
  RTCPeerConnectionLike,
  RTCDataChannelLike,
  RTCRtpSenderLike,
  MediaStreamLike,
  MediaStreamTrackLike,
} from '../types';
import type { IceServerConfig } from '@ponter/shared';

class WeriftDataChannel implements RTCDataChannelLike {
  private readonly stateHandlers: Array<(state: string) => void> = [];

  constructor(
    private readonly dc: InstanceType<
      typeof WeriftPC
    >['createDataChannel'] extends (...args: never[]) => infer R
      ? R
      : never,
  ) {
    // Normalise werift's stateChanged event
    this.dc.stateChanged.subscribe((state) => {
      for (const handler of this.stateHandlers) {
        handler(state);
      }
    });
  }

  get label(): string {
    return this.dc.label;
  }

  get readyState(): 'connecting' | 'open' | 'closing' | 'closed' {
    return this.dc.readyState;
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (typeof data === 'string') {
      this.dc.send(data);
    } else if (data instanceof ArrayBuffer) {
      this.dc.send(Buffer.from(data));
    } else {
      this.dc.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    }
  }

  close(): void {
    this.dc.close();
  }

  onMessage(handler: (data: string | ArrayBuffer) => void): void {
    this.dc.onMessage.subscribe((raw) => {
      if (typeof raw === 'string') {
        handler(raw);
        return;
      }
      // werift delivers Buffers; the seam hands consumers an ArrayBuffer so both
      // adapters agree. Copy the exact byte range: a Buffer is a view into a
      // shared pool, so handing out `raw.buffer` would leak unrelated bytes, and
      // `Buffer.buffer` is ArrayBufferLike (ArrayBuffer | SharedArrayBuffer),
      // which the seam's `ArrayBuffer` does not accept.
      const copy = new ArrayBuffer(raw.byteLength);
      new Uint8Array(copy).set(raw);
      handler(copy);
    });
  }

  onStateChange(handler: (state: string) => void): void {
    this.stateHandlers.push(handler);
  }
}

export class WeriftAdapter implements RTCPeerConnectionLike {
  private readonly pc: WeriftPC;
  private readonly iceHandlers: Array<
    (candidate: RTCIceCandidateInit) => void
  > = [];
  private readonly channelHandlers: Array<
    (channel: RTCDataChannelLike) => void
  > = [];
  private readonly stateHandlers: Array<(state: string) => void> = [];
  private readonly trackHandlers: Array<
    (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void
  > = [];
  private readonly senders: RTCRtpSenderLike[] = [];
  /** Outbound tracks this adapter created, so `addTrack` can recover the werift instance. */
  private readonly outboundTracks = new Map<
    MediaStreamTrackLike,
    WeriftMediaStreamTrack
  >();
  /** Outbound tracks by track id, for `getOutboundTrackCodec`. */
  private readonly tracksById = new Map<string, WeriftMediaStreamTrack>();

  constructor(
    config: {
      iceServers?: IceServerConfig[];
      codecs?: {
        audio?: RTCRtpCodecParameters[];
        video?: RTCRtpCodecParameters[];
      };
    } = {},
  ) {
    const rtcIceServers = (config.iceServers ?? []).map((s) => ({
      urls: s.urls,
      ...(s.username ? { username: s.username } : {}),
      ...(s.credential ? { credential: s.credential } : {}),
    }));

    this.pc = new WeriftPC({
      iceServers: rtcIceServers,
      ...(config.codecs ? { codecs: config.codecs } : {}),
    });

    this.pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) {
        const init: RTCIceCandidateInit = {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
          usernameFragment: candidate.usernameFragment ?? null,
        };
        for (const handler of this.iceHandlers) {
          handler(init);
        }
      }
    });

    this.pc.onDataChannel.subscribe((channel) => {
      const wrapped = new WeriftDataChannel(channel as never);
      for (const handler of this.channelHandlers) {
        handler(wrapped);
      }
    });

    this.pc.connectionStateChange.subscribe((state) => {
      for (const handler of this.stateHandlers) {
        handler(state);
      }
    });

    // werift fires BOTH onTrack and the DOM-style ontrack for the same track;
    // subscribing to exactly one of them avoids double delivery. `onTrack`
    // carries no streams array, so pass `[]` — consumers must not require it.
    this.pc.onTrack.subscribe((track) => {
      for (const handler of this.trackHandlers) {
        handler(track as MediaStreamTrackLike, []);
      }
    });
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    return {
      type: offer.type as RTCSdpType,
      sdp: offer.sdp,
    };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    const answer = await this.pc.createAnswer();
    return {
      type: answer.type as RTCSdpType,
      sdp: answer.sdp,
    };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    await this.pc.setLocalDescription({
      type: description.type as never,
      sdp: description.sdp,
    });
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    await this.pc.setRemoteDescription({
      type: description.type as never,
      sdp: description.sdp,
    });
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(candidate);
  }

  createDataChannel(
    label: string,
    options?: RTCDataChannelInit,
  ): RTCDataChannelLike {
    const dc = this.pc.createDataChannel(label, options);
    return new WeriftDataChannel(dc as never);
  }

  onIceCandidate(handler: (candidate: RTCIceCandidateInit) => void): void {
    this.iceHandlers.push(handler);
  }

  onDataChannel(handler: (channel: RTCDataChannelLike) => void): void {
    this.channelHandlers.push(handler);
  }

  onConnectionStateChange(handler: (state: string) => void): void {
    this.stateHandlers.push(handler);
  }

  addTransceiver(kind: string, options?: { direction?: string }): unknown {
    return this.pc.addTransceiver(
      kind as 'video',
      options as Partial<TransceiverOptions>,
    );
  }

  onTrack(
    handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void,
  ): void {
    this.trackHandlers.push(handler);
  }

  /**
   * Create an outbound track of the given kind.
   *
   * A werift `MediaStreamTrack` is the object the RTP packets are pushed
   * into; it is not a media source (there is no `srcObject` in Node), so it
   * is created empty and the agent writes RTP into it directly.
   *
   * Returns the werift track ITSELF, widened to `MediaStreamTrackLike`. It
   * is deliberately not projected into `{ kind, id: track.id, ssrc: track.ssrc }`:
   * at construction both `id` and `ssrc` are `undefined` (verified), and
   * `RTCRtpSender.registerTrack` assigns `track.id` later (rtpSender.js:429)
   * while never assigning `ssrc` at all. A projection would return a fresh
   * object carrying two `undefined`s, and `addTrack` would then have no way
   * back to the instance the packets must go into.
   */
  createOutboundTrack(kind: 'audio' | 'video'): MediaStreamTrackLike {
    const track = new WeriftMediaStreamTrack({ kind });
    const handle = track as unknown as MediaStreamTrackLike;
    this.outboundTracks.set(handle, track);
    return handle;
  }

  /** Recover the werift track behind a `MediaStreamTrackLike` this adapter produced. */
  private createWeriftTrack(
    track: MediaStreamTrackLike,
  ): WeriftMediaStreamTrack {
    const known = this.outboundTracks.get(track);
    if (known) return known;
    // A track this adapter did not create. werift can still take it, but it
    // carries none of our sender bookkeeping — surface that as a clear error
    // rather than a silent second m-line.
    throw new Error(
      'WeriftAdapter.addTrack received a track it did not create; call createOutboundTrack(kind) first.',
    );
  }

  /** Build the werift stream wrapper for an outbound track. */
  private createWeriftStream(track: MediaStreamTrackLike): WeriftMediaStream {
    const stream = new WeriftMediaStream();
    stream.addTrack(this.createWeriftTrack(track));
    return stream;
  }

  /** The senders this peer holds, in attach order. */
  getSenders(): RTCRtpSenderLike[] {
    return [...this.senders];
  }

  /**
   * The codec the given outbound track stamps onto packets.
   *
   * R-S3's re-pointing has to move `sender.codec` AND `track.codec`
   * (rtpSender.js:544 vs track.js:132-134), and a sender-only move is silent:
   * the sender says H.264:102 while the track keeps stamping 104. This
   * accessor exists so the test can assert the second half.
   */
  getOutboundTrackCodec(trackId: string): RTCRtpSenderLike['codec'] {
    return this.tracksById.get(trackId)?.codec as RTCRtpSenderLike['codec'];
  }

  /**
   * Attach an outbound track.
   *
   * The transceiver is created HERE, before setRemoteDescription — adding it
   * afterwards yields a second, a=inactive m-line whose sender.codec is
   * undefined, and werift's sendRtp then silently no-ops (spec R-S4, D4e).
   *
   * Note that werift's `addTrack` reuses an existing sender-less transceiver
   * when one matches (`transceiverManager.js:110-152`), so calling this after
   * `addTransceiver('video', { direction: 'sendrecv' })` attaches the track to
   * that transceiver rather than creating a second m-line.
   */
  addTrack(
    track: MediaStreamTrackLike,
    stream?: MediaStreamLike,
  ): RTCRtpSenderLike {
    const weriftTrack = this.createWeriftTrack(track);
    const weriftStream = stream ? this.createWeriftStream(track) : undefined;

    // werift's `pc.addTrack` returns the SENDER, not the transceiver
    // (peerConnection.js:981 — `return transceiver.sender`). The transceiver
    // is the object that owns `codecs` and that the answer is built from
    // (sdpManager.js:90), so it has to be looked up separately.
    // `getTransceivers()` is ordered and `RTCRtpSender` holds no back-pointer
    // to its transceiver (rtpTransceiver.js:15-30), so identity comparison on
    // the sender is the only correct key.
    const weriftSender = this.pc.addTrack(
      weriftTrack,
      ...(weriftStream ? [weriftStream] : []),
    );
    const transceiver = this.pc
      .getTransceivers()
      .find((t) => t.sender === weriftSender);
    if (!transceiver) {
      throw new Error(
        'werift returned a sender that belongs to no transceiver; this adapter cannot manage its codecs.',
      );
    }

    // `registerTrack` has now assigned `track.id = sender.trackId`
    // (rtpSender.js:429), so the id is readable for the first time here.
    // `ssrc` is still `undefined` — werift never assigns it on the track; the
    // sender stamps its own SSRC onto the wire.
    if (weriftTrack.id) {
      this.tracksById.set(weriftTrack.id, weriftTrack);
    }

    const handle: RTCRtpSenderLike = {
      get codec() {
        return weriftSender.codec as RTCRtpSenderLike['codec'];
      },
      selectNegotiatedCodec(codec) {
        const negotiated = transceiver.codecs ?? [];
        const entry = negotiated.find(
          (c) =>
            c.mimeType.toLowerCase() === codec.mimeType.toLowerCase() &&
            c.payloadType === codec.payloadType,
        );
        if (!entry) {
          throw new Error(
            `Codec ${codec.mimeType}:${codec.payloadType} was not negotiated; ` +
              `the peer offered ${negotiated.map((c) => `${c.mimeType}:${c.payloadType}`).join(', ')}.`,
          );
        }
        // R-S3 — re-point the sender at the chosen entry.
        //
        // THREE objects have to be moved together, and missing any one of
        // them is a silent failure:
        //
        //  1. `transceiver.codecs` — reordered so the chosen entry leads.
        //     werift's answer is built from this list (sdpManager.js:90-100),
        //     so the m-line's payload-type order and the `a=fmtp:` lines
        //     follow it. This does NOT re-point the sender: `prepareSend` ran
        //     already, inside `setRemoteDescription`
        //     (transceiverManager.js:276-277).
        //  2. `sender.codec` — the sender stamps this payload type on the
        //     wire (rtpSender.js:544), and this is the assignment that
        //     actually moves the sender off the mode-0 entry.
        //  3. `track.codec` — `MediaStreamTrack.writeRtp` overwrites the
        //     packet's payload type with THIS value (track.js:132-134), and
        //     `track.codec` is a separate field from `sender.codec`. Setting
        //     only the sender leaves the track stamping the OLD payload type
        //     into the packet, and the browser depacketizes it wrongly.
        //
        // MUTATE the codec object in place, never replace it: `{...codec}`
        // drops the `name` prototype getter (parameters.js:54-56) and
        // sdpManager.js:107 then throws `TypeError: Cannot read properties of
        // undefined (reading 'toLowerCase')`.
        transceiver.codecs = [entry, ...negotiated.filter((c) => c !== entry)];
        weriftSender.codec = entry;
        weriftTrack.codec = entry;
      },
      writeRtp(packet: Uint8Array) {
        weriftTrack.writeRtp(Buffer.from(packet));
      },
    };
    this.senders.push(handle);
    return handle;
  }

  async getStats(): Promise<RTCStatsReport> {
    return await this.pc.getStats();
  }

  async close(): Promise<void> {
    await this.pc.close();
  }
}

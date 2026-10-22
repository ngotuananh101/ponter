import type { IceServerConfig, SignalMessage } from '@ponter/shared';

export interface RTCDataChannelLike {
  readonly label: string;
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  onMessage(handler: (data: string | ArrayBuffer) => void): void;
  onStateChange(handler: (state: string) => void): void;
}

/**
 * A negotiated RTP codec, as both adapters and werift describe it.
 *
 * Kept structural rather than imported from `werift` so this package's public
 * types do not leak a dependency the browser adapter cannot satisfy.
 */
export interface RTCRtpCodecLike {
  mimeType: string;
  payloadType: number;
  parameters?: string;
}

export interface MediaStreamTrackLike {
  readonly kind: string;
  /**
   * The track's identifier. Optional because the three existing
   * `{ kind: 'video' }` literals in this repo
   * (`packages/webrtc-core/test/media-channel.test.ts:19`,
   * `packages/desktop-core/test/client.test.ts:20` and `:187`) satisfy this
   * interface structurally, and `packages/desktop` typechecks against it.
   * Making `id` required turns all three into TS2741 errors.
   */
  readonly id?: string;
  /** The track's RTP SSRC. Optional for the same reason as `id`. */
  readonly ssrc?: number;
  /**
   * The codec werift's `writeRtp` stamps onto every packet it is handed
   * (`track.js:132-134`). Optional because only the werift adapter has one.
   * R-S3's re-pointing has to move this field as well as the sender's.
   */
  readonly codec?: RTCRtpCodecLike;
}

/**
 * A sender handle for one outbound media track.
 *
 * Introduced by the agent rewrite (spec §3.5). It is deliberately read-only
 * on `codec` and write-only on `writeRtp`: the adapter owns the RTP
 * bookkeeping (SSRC, payload type, sequence number, timestamp) and the
 * caller supplies only the payload bytes.
 */
export interface RTCRtpSenderLike {
  /** The negotiated codec, read back after setRemoteDescription + createAnswer. */
  readonly codec?: RTCRtpCodecLike;
  /**
   * Point the sender at a specific negotiated codec.
   *
   * This is R-S3's mechanism (spec §3.5.1). werift filters the remote codec
   * list by mime type only and never inspects `fmtp`, so a browser whose
   * *first* H.264 entry is `packetization-mode=0` would otherwise be
   * negotiated onto a mode-0 payload type while the packetizer emits mode-1
   * framing. The caller re-points the sender at the browser's
   * `packetization-mode=1` entry; the answer's `a=fmtp:` line for that
   * payload type then stays byte-identical to the offer's.
   *
   * Throws when the codec is not one of the negotiated ones.
   */
  selectNegotiatedCodec(codec: RTCRtpCodecLike): void;
  /** Push one outbound RTP packet. The adapter stamps SSRC / PT / seq / timestamp. */
  writeRtp(packet: Uint8Array): void;
}

export interface MediaStreamLike {
  getTracks(): MediaStreamTrackLike[];
}

export interface RTCPeerConnectionLike {
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  createDataChannel(
    label: string,
    options?: RTCDataChannelInit,
  ): RTCDataChannelLike;
  onIceCandidate(handler: (candidate: RTCIceCandidateInit) => void): void;
  onDataChannel(handler: (channel: RTCDataChannelLike) => void): void;
  onConnectionStateChange(handler: (state: string) => void): void;
  getStats(): Promise<RTCStatsReport>;
  close(): Promise<void>;
  /**
   * Optional media seam (ADR-06/ADR-20). Optional so every existing mock and
   * adapter keeps typechecking; an adapter that lacks it is rejected with a
   * descriptive error when `media.video` is requested.
   */
  addTransceiver?(kind: string, options?: { direction?: string }): unknown;
  onTrack?(
    handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void,
  ): void;
  /**
   * Optional media seam (ADR-06/ADR-46). Returns the first RTCRtpReceiver whose
   * track is video, or `undefined` when none exists or the adapter does not
   * implement it. Used by desktop-core to apply playout-delay tuning. Optional so
   * every existing mock and adapter (e.g. werift) keeps typechecking without
   * changes; callers must treat `undefined` as "no video receiver".
   */
  getVideoReceiver?(): unknown;
  /**
   * Attach an outbound track and return its sender.
   *
   * Optional because every existing adapter and mock implements this
   * interface; a caller that asks for `media.video` and finds no `addTrack`
   * gets a descriptive error, exactly as `addTransceiver` does today.
   */
  addTrack?(
    track: MediaStreamTrackLike,
    stream?: MediaStreamLike,
  ): RTCRtpSenderLike;
  /**
   * The senders this peer holds, in transceiver order.
   *
   * Optional for the same reason as `addTrack`. A caller that needs a
   * sender but finds no `getSenders` gets a descriptive error.
   */
  getSenders?(): RTCRtpSenderLike[];
}

export interface PeerConnectionOptions {
  iceServers?: IceServerConfig[];
  role: 'offerer' | 'answerer';
  channelLabels: string[];
  /**
   * The server-assigned session ID the offer/answer signals carry. Used as the
   * binding in the WS2 identity proof so the signature cannot be replayed across
   * sessions.
   */
  sessionId: string;
  /** Capabilities sent in the offer. Falls back to `channelLabels`. */
  capabilities?: string[];
  /** Request receive-side media setup before the offer is created. */
  media?: { video?: boolean };
  connectTimeoutMs?: number;
  /**
   * WS2 peer identity: signs this peer's SDP and verifies the remote proof.
   * Absent → no verification (legacy/loopback path). When present, fail-closed.
   */
  identity?: PeerConnectionIdentity;
}

export interface PeerConnectionIdentity {
  role: 'offerer' | 'answerer';
  /** Base64 Ed25519 public key sent in the offer so the remote peer can verify
   * this peer's proof. Required for offerers, absent on answerers. */
  userSigningPublicKey?: string;
  sign: (message: string) => Promise<string>;
  verifyPeer: (message: string, signatureBase64: string) => Promise<boolean>;
}

export interface SignalTransport {
  send(msg: SignalMessage): Promise<void>;
  subscribe(handler: (msg: SignalMessage) => void): () => void;
  close(): void;
}

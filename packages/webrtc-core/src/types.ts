import type { IceServerConfig, SignalMessage } from '@ponter/shared';

export interface RTCDataChannelLike {
  readonly label: string;
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  onMessage(handler: (data: string | ArrayBuffer) => void): void;
  onStateChange(handler: (state: string) => void): void;
}

export interface MediaStreamTrackLike {
  readonly kind: string;
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

import type { IceServerConfig, SignalMessage } from '@remote/shared';

export interface RTCDataChannelLike {
  readonly label: string;
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  onMessage(handler: (data: string | ArrayBuffer) => void): void;
  onStateChange(handler: (state: string) => void): void;
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
}

export interface PeerConnectionOptions {
  iceServers?: IceServerConfig[];
  role: 'offerer' | 'answerer';
  channelLabels: string[];
  connectTimeoutMs?: number;
}

export interface SignalTransport {
  send(msg: SignalMessage): Promise<void>;
  subscribe(handler: (msg: SignalMessage) => void): () => void;
  close(): void;
}

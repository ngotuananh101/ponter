import { RTCPeerConnection as WeriftPC } from 'werift';
import type {
  RTCPeerConnectionLike,
  RTCDataChannelLike,
} from '../types';
import type { IceServerConfig } from '@remote/shared';

class WeriftDataChannel implements RTCDataChannelLike {
  private readonly stateHandlers: Array<(state: string) => void> = [];

  constructor(private readonly dc: InstanceType<typeof WeriftPC>['createDataChannel'] extends (...args: never[]) => infer R ? R : never) {
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
      this.dc.send(Buffer.from(data));
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
  private readonly iceHandlers: Array<(candidate: RTCIceCandidateInit) => void> = [];
  private readonly channelHandlers: Array<(channel: RTCDataChannelLike) => void> = [];
  private readonly stateHandlers: Array<(state: string) => void> = [];

  constructor(config: { iceServers?: IceServerConfig[] } = {}) {
    const rtcIceServers = (config.iceServers ?? []).map((s) => ({
      urls: s.urls,
      ...(s.username ? { username: s.username } : {}),
      ...(s.credential ? { credential: s.credential } : {}),
    }));

    this.pc = new WeriftPC({ iceServers: rtcIceServers });

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

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setLocalDescription({
      type: description.type as never,
      sdp: description.sdp,
    });
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription({
      type: description.type as never,
      sdp: description.sdp,
    });
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(candidate);
  }

  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannelLike {
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

  async getStats(): Promise<RTCStatsReport> {
    return await this.pc.getStats();
  }

  async close(): Promise<void> {
    await this.pc.close();
  }
}

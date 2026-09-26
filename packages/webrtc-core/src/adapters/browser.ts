import type { RTCPeerConnectionLike, RTCDataChannelLike } from '../types';
import type { IceServerConfig } from '@remote/shared';

class BrowserDataChannel implements RTCDataChannelLike {
  constructor(private readonly dc: RTCDataChannel) {}

  get label(): string {
    return this.dc.label;
  }

  get readyState(): 'connecting' | 'open' | 'closing' | 'closed' {
    return this.dc.readyState;
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    // lib.dom declares four separate `send` overloads (string, Blob,
    // ArrayBuffer, ArrayBufferView) with NO union overload, so a union argument
    // matches none of them. Narrow explicitly. Re-wrapping the bytes in a fresh
    // Uint8Array also widens ArrayBufferLike to ArrayBuffer for the overload.
    if (typeof data === 'string') {
      this.dc.send(data);
    } else if (data instanceof ArrayBuffer) {
      this.dc.send(data);
    } else {
      this.dc.send(new Uint8Array(data));
    }
  }

  close(): void {
    this.dc.close();
  }

  onMessage(handler: (data: string | ArrayBuffer) => void): void {
    this.dc.addEventListener('message', (event) => {
      handler(event.data);
    });
  }

  onStateChange(handler: (state: string) => void): void {
    const fire = () => handler(this.dc.readyState);
    this.dc.addEventListener('open', fire);
    this.dc.addEventListener('close', fire);
    this.dc.addEventListener('error', fire);
  }
}

export class BrowserAdapter implements RTCPeerConnectionLike {
  private readonly pc: RTCPeerConnection;
  private readonly iceHandlers: Array<
    (candidate: RTCIceCandidateInit) => void
  > = [];
  private readonly channelHandlers: Array<
    (channel: RTCDataChannelLike) => void
  > = [];
  private readonly stateHandlers: Array<(state: string) => void> = [];

  constructor(config: { iceServers?: IceServerConfig[] } = {}) {
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error(
        'BrowserAdapter requires RTCPeerConnection in the global environment',
      );
    }

    const rtcIceServers: RTCIceServer[] = (config.iceServers ?? []).map(
      (s) => ({
        urls: s.urls,
        ...(s.username ? { username: s.username } : {}),
        ...(s.credential ? { credential: s.credential } : {}),
      }),
    );

    this.pc = new RTCPeerConnection({ iceServers: rtcIceServers });

    this.pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        const init = event.candidate.toJSON();
        for (const handler of this.iceHandlers) {
          handler(init);
        }
      }
    });

    this.pc.addEventListener('datachannel', (event) => {
      const wrapped = new BrowserDataChannel(event.channel);
      for (const handler of this.channelHandlers) {
        handler(wrapped);
      }
    });

    this.pc.addEventListener('connectionstatechange', () => {
      for (const handler of this.stateHandlers) {
        handler(this.pc.connectionState);
      }
    });
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return await this.pc.createOffer();
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return await this.pc.createAnswer();
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    await this.pc.setLocalDescription(description);
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    await this.pc.setRemoteDescription(description);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(candidate);
  }

  createDataChannel(
    label: string,
    options?: RTCDataChannelInit,
  ): RTCDataChannelLike {
    const dc = this.pc.createDataChannel(label, options);
    return new BrowserDataChannel(dc);
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
    this.pc.close();
  }
}

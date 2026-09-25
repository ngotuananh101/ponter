import type { RTCDataChannelLike } from './types';
import type { DataChannelMessage, WebRTCChannelType } from '@remote/shared';

export class DataChannelManager {
  private readonly channels = new Map<string, RTCDataChannelLike>();
  private readonly rawMessageHandlers = new Map<
    string,
    Array<(data: string | ArrayBuffer) => void>
  >();
  private readonly typedMessageHandlers = new Map<
    string,
    Array<(msg: DataChannelMessage) => void>
  >();
  private readonly stateHandlers = new Map<
    string,
    Array<(state: string) => void>
  >();

  registerChannel(channel: RTCDataChannelLike): void {
    const label = channel.label;
    this.channels.set(label, channel);

    channel.onMessage((data) => {
      // 1. Raw listeners
      const rawList = this.rawMessageHandlers.get(label);
      if (rawList) {
        for (const handler of [...rawList]) {
          handler(data);
        }
      }

      // 2. Typed listeners
      const typedList = this.typedMessageHandlers.get(label);
      if (typedList && typeof data === 'string') {
        try {
          const parsed = JSON.parse(data) as DataChannelMessage;
          if (parsed && typeof parsed.type === 'string') {
            for (const handler of [...typedList]) {
              handler(parsed);
            }
          }
        } catch {
          // ignore non-JSON messages on typed listeners
        }
      }
    });

    channel.onStateChange((state) => {
      const list = this.stateHandlers.get(label);
      if (list) {
        for (const handler of [...list]) {
          handler(state);
        }
      }
    });
  }

  getChannel(label: string): RTCDataChannelLike | undefined {
    return this.channels.get(label);
  }

  hasChannel(label: string): boolean {
    return this.channels.has(label);
  }

  sendRaw(label: string, data: string | ArrayBuffer | Uint8Array): void {
    const channel = this.channels.get(label);
    if (!channel) {
      throw new Error(`Data channel "${label}" is not registered`);
    }
    channel.send(data);
  }

  sendJson<T>(label: string, type: string, payload: T): void {
    const channel = this.channels.get(label);
    if (!channel) {
      throw new Error(`Data channel "${label}" is not registered`);
    }

    const message: DataChannelMessage<T> = {
      channel: label as WebRTCChannelType,
      type,
      payload,
      timestamp: Date.now(),
    };

    channel.send(JSON.stringify(message));
  }

  onRawMessage(
    label: string,
    handler: (data: string | ArrayBuffer) => void,
  ): () => void {
    let list = this.rawMessageHandlers.get(label);
    if (!list) {
      list = [];
      this.rawMessageHandlers.set(label, list);
    }
    list.push(handler);

    return () => {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  onMessage<T = unknown>(
    label: string,
    handler: (msg: DataChannelMessage<T>) => void,
  ): () => void {
    let list = this.typedMessageHandlers.get(label);
    if (!list) {
      list = [];
      this.typedMessageHandlers.set(label, list);
    }
    list.push(handler as (msg: DataChannelMessage) => void);

    return () => {
      const idx = list.indexOf(handler as (msg: DataChannelMessage) => void);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  onStateChange(label: string, handler: (state: string) => void): () => void {
    let list = this.stateHandlers.get(label);
    if (!list) {
      list = [];
      this.stateHandlers.set(label, list);
    }
    list.push(handler);

    return () => {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  closeAll(): void {
    for (const channel of this.channels.values()) {
      try {
        channel.close();
      } catch {
        // ignore close errors
      }
    }
    this.channels.clear();
  }
}

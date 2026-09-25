import { describe, it, expect } from 'vitest';
import { DataChannelManager } from '../src/data-channel';
import type { RTCDataChannelLike } from '../src/types';

class MockDataChannel implements RTCDataChannelLike {
  public readyState: 'connecting' | 'open' | 'closing' | 'closed' =
    'connecting';
  public sentData: Array<string | ArrayBuffer | Uint8Array> = [];
  private messageHandlers: Array<(data: string | ArrayBuffer) => void> = [];
  private stateHandlers: Array<(state: string) => void> = [];

  constructor(public readonly label: string) {}

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 'open') {
      throw new Error(`Channel ${this.label} is not open`);
    }
    this.sentData.push(data);
  }

  close(): void {
    this.readyState = 'closed';
    for (const h of this.stateHandlers) h('closed');
  }

  onMessage(handler: (data: string | ArrayBuffer) => void): void {
    this.messageHandlers.push(handler);
  }

  onStateChange(handler: (state: string) => void): void {
    this.stateHandlers.push(handler);
  }

  simulateOpen(): void {
    this.readyState = 'open';
    for (const h of this.stateHandlers) h('open');
  }

  simulateMessage(data: string | ArrayBuffer): void {
    for (const h of this.messageHandlers) h(data);
  }
}

describe('DataChannelManager', () => {
  it('registers and retrieves channels by label', () => {
    const mgr = new DataChannelManager();
    const ch = new MockDataChannel('terminal');
    mgr.registerChannel(ch);

    expect(mgr.hasChannel('terminal')).toBe(true);
    expect(mgr.getChannel('terminal')).toBe(ch);
    expect(mgr.hasChannel('control')).toBe(false);
  });

  it('routes raw messages from registered channels', () => {
    const mgr = new DataChannelManager();
    const ch = new MockDataChannel('terminal');
    mgr.registerChannel(ch);

    const received: string[] = [];
    mgr.onRawMessage('terminal', (data) => received.push(String(data)));

    ch.simulateMessage('hello terminal');
    expect(received).toEqual(['hello terminal']);
  });

  it('frames and sends typed DataChannelMessage payloads', () => {
    const mgr = new DataChannelManager();
    const ch = new MockDataChannel('control');
    mgr.registerChannel(ch);
    ch.simulateOpen();

    mgr.sendJson('control', 'ping', { seq: 1 });

    expect(ch.sentData).toHaveLength(1);
    const parsed = JSON.parse(ch.sentData[0] as string);
    expect(parsed.channel).toBe('control');
    expect(parsed.type).toBe('ping');
    expect(parsed.payload).toEqual({ seq: 1 });
    expect(typeof parsed.timestamp).toBe('number');
  });

  it('parses and routes typed DataChannelMessage on receive', () => {
    const mgr = new DataChannelManager();
    const ch = new MockDataChannel('control');
    mgr.registerChannel(ch);

    const received: Array<{ type: string; payload: unknown }> = [];
    mgr.onMessage('control', (msg) => {
      received.push({ type: msg.type, payload: msg.payload });
    });

    ch.simulateMessage(
      JSON.stringify({
        channel: 'control',
        type: 'ack',
        payload: { ok: true },
        timestamp: Date.now(),
      }),
    );

    expect(received).toEqual([{ type: 'ack', payload: { ok: true } }]);
  });

  it('notifies on channel state transitions', () => {
    const mgr = new DataChannelManager();
    const ch = new MockDataChannel('files');
    mgr.registerChannel(ch);

    const states: string[] = [];
    mgr.onStateChange('files', (s) => states.push(s));

    ch.simulateOpen();
    ch.close();

    expect(states).toEqual(['open', 'closed']);
  });

  it('closes all registered channels on closeAll()', () => {
    const mgr = new DataChannelManager();
    const ch1 = new MockDataChannel('terminal');
    const ch2 = new MockDataChannel('desktop');
    mgr.registerChannel(ch1);
    mgr.registerChannel(ch2);
    ch1.simulateOpen();
    ch2.simulateOpen();

    mgr.closeAll();

    expect(ch1.readyState).toBe('closed');
    expect(ch2.readyState).toBe('closed');
  });
});

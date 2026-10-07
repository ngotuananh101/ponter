import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAdapter } from '../src/adapters/browser';

const originalRTCPeerConnection = globalThis.RTCPeerConnection;

afterEach(() => {
  globalThis.RTCPeerConnection = originalRTCPeerConnection;
});

interface MockPC {
  addEventListener: ReturnType<typeof vi.fn>;
  getReceivers: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/** Set of mock PCs created; the test reads getReceivers from the latest one. */
let mockPC: MockPC;

function installMockRTCPeerConnection(
  receivers: Array<{ track?: { kind?: string } }>,
) {
  mockPC = {
    addEventListener: vi.fn(),
    getReceivers: vi.fn(() => receivers),
    close: vi.fn(),
  };
  // Use a real constructor function so `new RTCPeerConnection(...)` works.
  function MockRTCPeerConnection(this: MockPC) {
    Object.assign(this, mockPC);
  }
  globalThis.RTCPeerConnection =
    MockRTCPeerConnection as unknown as typeof RTCPeerConnection;
}

describe('BrowserAdapter.getVideoReceiver', () => {
  it('returns the receiver whose track kind is "video"', () => {
    const receivers = [
      { track: { kind: 'audio' }, toJSON: vi.fn() },
      { track: { kind: 'video' }, toJSON: vi.fn() },
    ];
    installMockRTCPeerConnection(receivers);
    const adapter = new BrowserAdapter();
    const receiver = adapter.getVideoReceiver();
    expect(receiver).toBe(receivers[1]);
  });

  it('returns undefined when no video receiver exists', () => {
    const receivers = [{ track: { kind: 'audio' } }];
    installMockRTCPeerConnection(receivers);
    const adapter = new BrowserAdapter();
    const receiver = adapter.getVideoReceiver();
    expect(receiver).toBeUndefined();
  });

  it('returns undefined when getReceivers returns an empty array', () => {
    installMockRTCPeerConnection([]);
    const adapter = new BrowserAdapter();
    const receiver = adapter.getVideoReceiver();
    expect(receiver).toBeUndefined();
  });
});

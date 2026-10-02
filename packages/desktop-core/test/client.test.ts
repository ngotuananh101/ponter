import { describe, expect, it, vi } from 'vitest';
import { DesktopClient } from '../src/client';
import type {
  MediaStreamLike,
  MediaStreamTrackLike,
} from '@ponter/webrtc-core';
import type { PeerConnection } from '@ponter/webrtc-core';

const fakeTrack: MediaStreamTrackLike = { kind: 'video' };
const fakeStreams: MediaStreamLike[] = [];

/**
 * Mock peer exposing only what DesktopClient touches: start, close,
 * onRemoteTrack, onConnectionStateChange. Mirrors the mock style of
 * terminal-errors.test.ts.
 */
function mockPeer() {
  let trackHandler:
    ((t: MediaStreamTrackLike, s: MediaStreamLike[]) => void) | null = null;
  let stateHandler: ((state: string) => void) | null = null;
  const removeTrackHandler = vi.fn();
  const removeStateHandler = vi.fn();

  return {
    peer: {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onRemoteTrack: vi.fn(
        (handler: (t: MediaStreamTrackLike, s: MediaStreamLike[]) => void) => {
          trackHandler = handler;
          return removeTrackHandler;
        },
      ),
      onConnectionStateChange: vi.fn((handler: (state: string) => void) => {
        stateHandler = handler;
        return removeStateHandler;
      }),
    } as unknown as PeerConnection,
    emitTrack: (t: MediaStreamTrackLike, s: MediaStreamLike[]) =>
      trackHandler?.(t, s),
    emitState: (state: string) => stateHandler?.(state),
    removeTrackHandler,
    removeStateHandler,
  };
}

describe('DesktopClient', () => {
  it('resolves with the first remote track', async () => {
    const { peer, emitTrack } = mockPeer();
    const client = new DesktopClient('agent-1', peer);

    const started = client.start();
    emitTrack(fakeTrack, fakeStreams);

    await expect(started).resolves.toEqual({
      track: fakeTrack,
      streams: fakeStreams,
    });
    client.close();
  });

  it('subscribes to tracks before calling peer.start()', async () => {
    const calls: string[] = [];
    const { peer } = mockPeer();
    (peer.onRemoteTrack as ReturnType<typeof vi.fn>).mockImplementation(
      (handler: (t: MediaStreamTrackLike, s: MediaStreamLike[]) => void) => {
        calls.push('onRemoteTrack');
        void handler;
        return () => {};
      },
    );
    (peer.start as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('start');
    });

    const client = new DesktopClient('agent-1', peer);
    const started = client.start();
    // The first negotiation tick must not be missed: subscription first.
    expect(calls).toEqual(['onRemoteTrack', 'start']);

    // Settle the promise so the test leaves no pending timer.
    client.close();
    await expect(started).rejects.toThrow(/closed/i);
  });

  it('does not re-resolve when a second track arrives', async () => {
    const { peer, emitTrack } = mockPeer();
    const client = new DesktopClient('agent-1', peer);

    const started = client.start();
    emitTrack(fakeTrack, fakeStreams);
    const first = await started;

    const second: MediaStreamTrackLike = { kind: 'video' };
    emitTrack(second, fakeStreams);

    // The promise resolved once; later tracks are not the first stream.
    expect(first.track).toBe(fakeTrack);
    client.close();
  });

  it('rejects with a timeout when no track arrives', async () => {
    const { peer } = mockPeer();
    const client = new DesktopClient('agent-1', peer, { trackTimeoutMs: 50 });

    await expect(client.start()).rejects.toThrow(/timed out.*50ms/i);
    client.close();
  });

  it('rejects when the connection fails before a track', async () => {
    const { peer, emitState } = mockPeer();
    const client = new DesktopClient('agent-1', peer);

    const started = client.start();
    emitState('failed');

    await expect(started).rejects.toThrow(/failed/i);
    client.close();
  });

  it('rejects when close() is called while waiting', async () => {
    const { peer } = mockPeer();
    const client = new DesktopClient('agent-1', peer);

    const started = client.start();
    client.close();

    await expect(started).rejects.toThrow(/closed/i);
  });

  it('close() is idempotent and closes the peer exactly once', async () => {
    const { peer } = mockPeer();
    const client = new DesktopClient('agent-1', peer);

    client.close();
    client.close();

    expect(peer.close).toHaveBeenCalledTimes(1);
  });

  it('forwards connection state changes to handlers', async () => {
    const { peer, emitState } = mockPeer();
    const client = new DesktopClient('agent-1', peer);

    const states: string[] = [];
    const unsubscribe = client.onConnectionStateChange((s) => states.push(s));

    emitState('connecting');
    unsubscribe();
    emitState('connected');

    expect(states).toEqual(['connecting']);
    client.close();
  });
});

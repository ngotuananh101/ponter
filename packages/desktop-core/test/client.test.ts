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
  // The registered channel's readyState, or `null` when the label is absent.
  // Mirrors the real manager: an offerer pre-creates the channel, so it is
  // *registered* (hasChannel true) while still `connecting`.
  let controlState: 'connecting' | 'open' | 'closed' | null = 'connecting';
  let controlHandler: ((msg: unknown) => void) | null = null;
  const removeTrackHandler = vi.fn();
  const removeStateHandler = vi.fn();
  const removeControlHandler = vi.fn();
  const sendJson = vi.fn();
  // Default: the control channel opens. A test can re-point this to a rejecting
  // mock to exercise the never-opens warning path.
  const waitForChannel = vi.fn(async (_label: string, _timeoutMs?: number) => ({
    label: 'control',
    readyState: 'open',
  }));

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
      dataChannels: {
        hasChannel: vi.fn((_label: string) => controlState !== null),
        getChannel: vi.fn((_label: string) =>
          controlState === null
            ? undefined
            : { label: 'control', readyState: controlState },
        ),
        onMessage: vi.fn((_label: string, handler: (msg: unknown) => void) => {
          controlHandler = handler;
          return removeControlHandler;
        }),
        sendJson,
      },
      // `subscribeControl` fires a best-effort `waitForChannel`; without this
      // stub the call would throw inside `start()` and break every existing
      // test. Default: resolve (the channel opened).
      waitForChannel,
    } as unknown as PeerConnection,
    emitTrack: (t: MediaStreamTrackLike, s: MediaStreamLike[]) =>
      trackHandler?.(t, s),
    emitState: (state: string) => stateHandler?.(state),
    emitControl: (msg: unknown) => controlHandler?.(msg),
    setControlOpen: (open: boolean) => {
      controlState = open ? 'open' : null;
    },
    setControlState: (state: 'connecting' | 'open' | 'closed' | null) => {
      controlState = state;
    },
    sendJson,
    waitForChannel,
    removeTrackHandler,
    removeStateHandler,
    removeControlHandler,
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

describe('DesktopClient control surface', () => {
  /** A connected client: start() resolved, so the control subscription is live. */
  async function connected() {
    const mock = mockPeer();
    const client = new DesktopClient('agent-1', mock.peer);
    const started = client.start();
    mock.emitTrack(fakeTrack, fakeStreams);
    await started;
    return { ...mock, client };
  }

  const oneSource = {
    id: 'monitor:1',
    kind: 'monitor' as const,
    name: 'eDP-1',
    width: 1920,
    height: 1080,
    x: 0,
    y: 0,
    scaleFactor: 1,
    rotation: 0,
    isPrimary: true,
    default: true,
  };

  it('dispatches desktop-sources to onSources and re-fires on a second frame', async () => {
    const { client, emitControl } = await connected();
    const seen: unknown[] = [];
    client.onSources((sources) => seen.push(sources));

    emitControl({
      type: 'desktop-sources',
      channel: 'control',
      payload: { sources: [oneSource] },
      timestamp: 1,
    });
    emitControl({
      type: 'desktop-sources',
      channel: 'control',
      payload: { sources: [] },
      timestamp: 2,
    });

    expect(seen).toEqual([[oneSource], []]);
    client.close();
  });

  it('stops delivering onSources after unsubscribe', async () => {
    const { client, emitControl } = await connected();
    const seen: unknown[] = [];
    const off = client.onSources((sources) => seen.push(sources));

    off();
    emitControl({
      type: 'desktop-sources',
      channel: 'control',
      payload: { sources: [oneSource] },
      timestamp: 1,
    });

    expect(seen).toEqual([]);
    client.close();
  });

  it('dispatches desktop-stats to onStats', async () => {
    const { client, emitControl } = await connected();
    const seen: unknown[] = [];
    client.onStats((stats) => seen.push(stats));

    emitControl({
      type: 'desktop-stats',
      channel: 'control',
      payload: {
        width: 1920,
        height: 1080,
        fps: 30,
        targetBitrateBps: 6_000_000,
      },
      timestamp: 1,
    });

    expect(seen).toEqual([
      { width: 1920, height: 1080, fps: 30, targetBitrateBps: 6_000_000 },
    ]);
    client.close();
  });

  // The agent pushes `desktop-sources` as soon as the control channel opens —
  // which can be before the store registers its listener. Without a replay the
  // picker stays empty forever, so the last frame must be cached and replayed.
  it('replays the last desktop-sources frame to a late listener', async () => {
    const { client, emitControl } = await connected();
    emitControl({
      type: 'desktop-sources',
      channel: 'control',
      payload: { sources: [oneSource] },
      timestamp: 1,
    });

    const seen: unknown[] = [];
    client.onSources((sources) => seen.push(sources));

    expect(seen).toEqual([[oneSource]]);
    client.close();
  });

  it('replays the last desktop-stats frame to a late listener', async () => {
    const { client, emitControl } = await connected();
    emitControl({
      type: 'desktop-stats',
      channel: 'control',
      payload: {
        width: 1920,
        height: 1080,
        fps: 30,
        targetBitrateBps: 6_000_000,
      },
      timestamp: 1,
    });

    const seen: unknown[] = [];
    client.onStats((stats) => seen.push(stats));

    expect(seen).toEqual([
      { width: 1920, height: 1080, fps: 30, targetBitrateBps: 6_000_000 },
    ]);
    client.close();
  });

  it('does not replay to a listener registered before any frame', async () => {
    const { client } = await connected();
    const seen: unknown[] = [];
    client.onSources((sources) => seen.push(sources));

    // Nothing cached yet: subscribing is not itself an event.
    expect(seen).toEqual([]);
    client.close();
  });

  it('drops a malformed desktop-stats frame instead of forwarding NaN', async () => {
    const { client, emitControl } = await connected();
    const seen: unknown[] = [];
    client.onStats((stats) => seen.push(stats));

    emitControl({
      type: 'desktop-stats',
      channel: 'control',
      payload: { width: 1280 },
      timestamp: 1,
    });
    emitControl({
      type: 'desktop-stats',
      channel: 'control',
      payload: null,
      timestamp: 2,
    });

    expect(seen).toEqual([]);
    client.close();
  });

  it('ignores an unknown control type without error', async () => {
    const { client, emitControl } = await connected();
    const sources: unknown[] = [];
    client.onSources((s) => sources.push(s));

    expect(() =>
      emitControl({
        type: 'desktop-future',
        channel: 'control',
        payload: {},
        timestamp: 1,
      }),
    ).not.toThrow();
    expect(sources).toEqual([]);
    client.close();
  });

  it('selectSource sends a desktop-select frame when the channel is open', async () => {
    const { client, sendJson, setControlState } = await connected();
    setControlState('open');

    client.selectSource('window:0x4a00007');

    expect(sendJson).toHaveBeenCalledWith('control', 'desktop-select', {
      sourceId: 'window:0x4a00007',
    });
    client.close();
  });

  it('setBitrate sends a desktop-bitrate frame when the channel is open', async () => {
    const { client, sendJson, setControlState } = await connected();
    setControlState('open');

    client.setBitrate(2_500_000);

    expect(sendJson).toHaveBeenCalledWith('control', 'desktop-bitrate', {
      bitrateBps: 2_500_000,
    });
    client.close();
  });

  it('selectSource and setBitrate warn instead of throwing when the channel is absent', async () => {
    const { client, sendJson, setControlState } = await connected();
    setControlState(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => client.selectSource('monitor:1')).not.toThrow();
    expect(() => client.setBitrate(1_000_000)).not.toThrow();
    expect(sendJson).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    client.close();
  });

  // The offerer pre-creates the channel in the constructor, so `hasChannel` is
  // true from the start even while the channel is still `connecting`. Sending
  // then throws InvalidStateError inside RTCDataChannel.send(), so the guard
  // must test readyState, not mere registration.
  it('selectSource and setBitrate warn while the channel is still connecting', async () => {
    const { client, sendJson, setControlState } = await connected();
    setControlState('connecting');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => client.selectSource('monitor:1')).not.toThrow();
    expect(() => client.setBitrate(1_000_000)).not.toThrow();
    expect(sendJson).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    client.close();
  });

  it('warns when the control channel never opens, without failing start()', async () => {
    const mock = mockPeer();
    // A channel that never opens: `waitForChannel` rejects after the timeout.
    mock.waitForChannel.mockRejectedValueOnce(
      new Error('timeout waiting for channel "control"'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new DesktopClient('agent-1', mock.peer);

    const started = client.start();
    mock.emitTrack(fakeTrack, fakeStreams);
    // Media must still resolve — a missing control channel is not fatal.
    await expect(started).resolves.toEqual({
      track: fakeTrack,
      streams: fakeStreams,
    });
    // Let the fire-and-forget rejection settle.
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('control channel did not open'),
    );
    warn.mockRestore();
    client.close();
  });
});

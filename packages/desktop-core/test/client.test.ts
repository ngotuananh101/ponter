import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopClient } from '../src/client';
import type { DesktopClientOptions, DesktopE2eeDriver } from '../src/types';
import type { DesktopInput } from '@ponter/shared';
import type {
  MediaStreamLike,
  MediaStreamTrackLike,
} from '@ponter/webrtc-core';
import type { PeerConnection } from '@ponter/webrtc-core';
import {
  buildSessionKey,
  exportPublicKeySpki,
  generateSigningKeyPair,
  generateUserKeyPair,
  importSigningPublicKeyRaw,
  signProof,
} from '@ponter/crypto';
import { canonicalKeyBinding } from '@ponter/shared';

const fakeTrack: MediaStreamTrackLike = { kind: 'video' };
const fakeStreams: MediaStreamLike[] = [];

/** Module-level so a test can inspect every `sendJson` frame the client sent. */
const mockSendJson =
  vi.fn<(label: string, type: string, payload: unknown) => void>();
/** The control handler of the most recently created mock, for `emitSources`. */
let currentEmitControl: ((msg: unknown) => void) | null = null;

/** Push a `desktop-sources` payload through the current mock's control handler. */
function emitSources(
  sources: Array<{ id: string; default: boolean }>,
  inputEnabled: boolean,
): void {
  currentEmitControl?.({
    type: 'desktop-sources',
    channel: 'control',
    payload: { sources, inputEnabled },
    timestamp: 1,
  });
}

beforeEach(() => {
  mockSendJson.mockClear();
});

/** A connected client: start() resolved, so the control subscription is live. */
async function connected(
  options?: DesktopClientOptions,
  e2de?: DesktopE2eeDriver,
) {
  const mock = mockPeer();
  const client = new DesktopClient('agent-1', mock.peer, options, e2de);
  const started = client.start();
  mock.emitTrack(fakeTrack, fakeStreams);
  await started;
  return { ...mock, client };
}

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
  const sendJson = mockSendJson;
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
          currentEmitControl = handler;
          return removeControlHandler;
        }),
        sendJson,
      },
      // `subscribeControl` fires a best-effort `waitForChannel`; without this
      // stub the call would throw inside `start()` and break every existing
      // test. Default: resolve (the channel opened).
      waitForChannel,
      // T6-A: negotiateE2ee reads `this.peer.options.sessionId` for the hello.
      options: { sessionId: 'test-session' },
    } as unknown as PeerConnection,
    emitTrack: (t: MediaStreamTrackLike, s: MediaStreamLike[]) =>
      trackHandler?.(t, s),
    emitState: (state: string) => stateHandler?.(state),
    emitControl: (msg: unknown) => controlHandler?.(msg),
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

  it('drops every listener on close() so a late frame reaches nobody', async () => {
    const { peer, emitState, emitControl } = mockPeer();
    const client = new DesktopClient('agent-1', peer);

    const states: string[] = [];
    const sources: unknown[] = [];
    const stats: unknown[] = [];
    client.onConnectionStateChange((s) => states.push(s));
    client.onSources((s) => sources.push(s));
    client.onStats((s) => stats.push(s));

    client.close();

    // A closed client must not fan out to handlers the caller can no longer
    // unsubscribe (its `off` closures are still held but the client is gone).
    emitState('connected');
    emitControl({
      type: 'desktop-sources',
      channel: 'control',
      payload: {
        sources: [{ id: 'monitor:1', default: true }],
        inputEnabled: false,
      },
      timestamp: 1,
    });
    emitControl({
      type: 'desktop-stats',
      channel: 'control',
      payload: {
        width: 1920,
        height: 1080,
        fps: 30,
        targetBitrateBps: 6_000_000,
      },
      timestamp: 2,
    });

    expect(states).toEqual([]);
    expect(sources).toEqual([]);
    expect(stats).toEqual([]);
  });
});

describe('DesktopClient control surface', () => {
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
    client.onSources((payload) => seen.push(payload));

    emitControl({
      type: 'desktop-sources',
      channel: 'control',
      payload: { sources: [oneSource], inputEnabled: false },
      timestamp: 1,
    });
    emitControl({
      type: 'desktop-sources',
      channel: 'control',
      payload: { sources: [], inputEnabled: false },
      timestamp: 2,
    });

    expect(seen).toEqual([
      { sources: [oneSource], inputEnabled: false },
      { sources: [], inputEnabled: false },
    ]);
    client.close();
  });

  it('stops delivering onSources after unsubscribe', async () => {
    const { client, emitControl } = await connected();
    const seen: unknown[] = [];
    const off = client.onSources((payload) => seen.push(payload));

    off();
    emitControl({
      type: 'desktop-sources',
      channel: 'control',
      payload: { sources: [oneSource], inputEnabled: false },
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
      payload: { sources: [oneSource], inputEnabled: true },
      timestamp: 1,
    });

    const seen: unknown[] = [];
    client.onSources((payload) => seen.push(payload));

    expect(seen).toEqual([{ sources: [oneSource], inputEnabled: true }]);
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

describe('DesktopClient input surface (Week 9, spec §5.3)', () => {
  const sentInputs = (): Array<{ type: string; payload: unknown }> =>
    mockSendJson.mock.calls
      .filter((c) => c[1] === 'desktop-input')
      .map((c) => ({ type: c[1], payload: c[2] }));

  const isKind = (kind: string) => (s: { payload: unknown }) =>
    (s.payload as { kind: string }).kind === kind;

  it('forwards a discrete event when the channel is open', async () => {
    const { client, setControlState } = await connected();
    setControlState('open');

    client.sendInput({
      kind: 'pointer-button',
      button: 'left',
      pressed: true,
      x: 0.5,
      y: 0.5,
    });

    expect(mockSendJson).toHaveBeenCalledWith('control', 'desktop-input', {
      kind: 'pointer-button',
      button: 'left',
      pressed: true,
      x: 0.5,
      y: 0.5,
    });
    client.close();
  });

  it('warns and does not throw when the channel is not open', async () => {
    const { client, setControlState } = await connected();
    setControlState('connecting');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => client.sendInput({ kind: 'text', text: 'a' })).not.toThrow();
    expect(sentInputs()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    client.close();
  });

  it('coalesces pointer-move to the configured rate and never drops discrete events', async () => {
    vi.useFakeTimers();
    try {
      const { client, setControlState } = await connected({
        inputRateLimitHz: 60,
      });
      setControlState('open');

      // 120 moves in the same tick: the first is forwarded now; the rest are
      // coalesced and flushed at most once per 1/60 s.
      for (let i = 0; i < 120; i++) {
        client.sendInput({ kind: 'pointer-move', x: i / 120, y: 0 });
      }
      client.sendInput({
        kind: 'key',
        code: 'KeyA',
        pressed: true,
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      });

      expect(sentInputs().filter(isKind('pointer-move'))).toHaveLength(1);
      expect(sentInputs().filter(isKind('key'))).toHaveLength(1);

      vi.advanceTimersByTime(17); // ~1/60 s
      const movesAfter = sentInputs().filter(isKind('pointer-move'));
      expect(movesAfter.length).toBeGreaterThanOrEqual(2);
      // The last move carries the newest position, not a stale one.
      expect((movesAfter.at(-1)?.payload as { x: number }).x).toBeCloseTo(
        119 / 120,
      );
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never coalesces discrete events even when the rate window is saturated', async () => {
    vi.useFakeTimers();
    try {
      const { client, setControlState } = await connected({
        inputRateLimitHz: 60,
      });
      setControlState('open');

      client.sendInput({ kind: 'pointer-move', x: 0.1, y: 0.1 });
      client.sendInput({ kind: 'pointer-move', x: 0.2, y: 0.2 });
      client.sendInput({ kind: 'wheel', dx: 0, dy: -1, x: 0.5, y: 0.5 });
      client.sendInput({ kind: 'wheel', dx: 0, dy: -1, x: 0.5, y: 0.5 });

      // Both wheel frames go out immediately, undeterred by the pending move.
      expect(sentInputs().filter(isKind('wheel'))).toHaveLength(2);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('strictly caps continuous pointer-move throughput to inputRateLimitHz', async () => {
    vi.useFakeTimers();
    try {
      const { client, setControlState } = await connected({
        inputRateLimitHz: 60,
      });
      setControlState('open');

      // Simulate a 500 Hz gaming mouse moving continuously for 1000 ms (1 move every 2 ms).
      for (let t = 0; t <= 1000; t += 2) {
        client.sendInput({ kind: 'pointer-move', x: t / 1000, y: 0 });
        vi.advanceTimersByTime(2);
      }

      const moves = sentInputs().filter(isKind('pointer-move'));
      // At 60 Hz over 1000 ms, at most ~61 frames (leading edge + 60 interval flushes).
      // A bug that flushes both leading and trailing edges yields ~111-120 frames.
      expect(moves.length).toBeLessThanOrEqual(61);
      expect(moves.length).toBeGreaterThanOrEqual(58);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces inputEnabled from the desktop-sources payload', async () => {
    const { client } = await connected();
    const seen: boolean[] = [];
    client.onSources((payload) => seen.push(payload.inputEnabled));

    emitSources([{ id: 'monitor:1', default: true }], true);

    expect(seen).toEqual([true]);
    client.close();
  });
});

/**
 * Build a real WS1 session key pair for two peers so the test can round-trip:
 * the browser-side `TerminalE2ee`-shaped driver encrypts, and a mirrored key
 * (built with `buildSessionKey` using the agent-side private key) decrypts.
 */
async function makePeerKeys(sessionId: string) {
  const ecdh = await generateUserKeyPair();
  const signing = await generateSigningKeyPair();
  const ecdhPublicKey = await exportPublicKeySpki(ecdh.publicKey);
  const signature = await signProof(
    signing.privateKey,
    canonicalKeyBinding(ecdhPublicKey),
  );
  return {
    ecdhPrivateKey: ecdh.privateKey,
    ecdhPublicKey,
    signature,
    signingPrivateKey: signing.privateKey,
    peerSigningPublicKey: await importSigningPublicKeyRaw(
      signing.publicKeyRawBase64,
    ),
    sessionId,
  };
}

/** A `DesktopE2eeDriver` stub: dormant until `activate()` flips it on. */
function stubDriver(): DesktopE2eeDriver & {
  activate: () => void;
  capturedHello: unknown;
} {
  const state = { active: false, capturedHello: null as unknown };
  return {
    isActive: () => state.active,
    buildHello: vi.fn(async (terminalId: string) => {
      state.capturedHello = { terminalId };
      return { terminalId, ecdhPublicKey: 'stub', signature: 'stub' };
    }),
    handleAck: vi.fn(async () => {
      state.active = true;
    }),
    encrypt: vi.fn(async (data: Uint8Array) =>
      new Uint8Array(data).map((b) => b ^ 0xff),
    ),
    decrypt: vi.fn(async (data: Uint8Array) => data),
    activate: () => {
      state.active = true;
    },
    get capturedHello() {
      return state.capturedHello;
    },
  };
}

describe('DesktopClient E2EE (Task 6b)', () => {
  it('plaintext parity: no driver sends the exact same frame as today', async () => {
    const { client, setControlState } = await connected();
    setControlState('open');

    const event = {
      kind: 'pointer-button',
      button: 'left',
      pressed: true,
      x: 0.5,
      y: 0.5,
    } as const;
    client.sendInput(event);

    expect(mockSendJson).toHaveBeenCalledWith(
      'control',
      'desktop-input',
      event,
    );
    client.close();
  });

  it('dormant driver: context buildable but no ack yet stays plaintext (byte-identity)', async () => {
    // T6-C byte-identity: when the driver exists but isActive() is false
    // (the agent never acked), desktop-input is sent as the flat event, not
    // { data: base64(...) }.
    const driver = stubDriver(); // dormant: isActive() === false
    const { client, setControlState } = await connected(undefined, driver);
    setControlState('open');

    const event: DesktopInput = {
      kind: 'pointer-button',
      button: 'left',
      pressed: true,
      x: 0.5,
      y: 0.5,
    };
    client.sendInput(event);

    expect(mockSendJson).toHaveBeenCalledWith(
      'control',
      'desktop-input',
      event,
    );
    client.close();
  });

  it('sends a desktop-e2ee-hello once the control channel opens (idempotent)', async () => {
    const driver = stubDriver();
    const mock = mockPeer();
    const client = new DesktopClient('agent-1', mock.peer, undefined, driver);
    const started = client.start();
    mock.emitTrack(fakeTrack, fakeStreams);
    await started;

    // The hello fires once the channel resolves inside subscribeControl, via the
    // ordered sendChain — give it a few microtask ticks to flush.
    const start = Date.now();
    while (
      !mockSendJson.mock.calls.some((c) => c[1] === 'desktop-e2ee-hello') &&
      Date.now() - start < 2000
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const hellos = mockSendJson.mock.calls.filter(
      (c) => c[1] === 'desktop-e2ee-hello',
    );
    expect(hellos).toHaveLength(1);
    expect(driver.buildHello).toHaveBeenCalledTimes(1);
    // terminalId for the hello is the session id.
    expect(driver.capturedHello).toEqual({ terminalId: 'test-session' });

    // A second start() must not fire a second hello (idempotency guard).
    // Re-subscribing would only happen via a new connection; instead just assert
    // the call count is still 1 after a tick.
    await Promise.resolve();
    expect(driver.buildHello).toHaveBeenCalledTimes(1);

    client.close();
  });

  it('decrypts ciphertext sent when active: round-trips the DesktopInput JSON', async () => {
    const browser = await makePeerKeys('sess-1');
    const agent = await makePeerKeys('sess-1');

    // Real key on the browser side: isActive starts false (hello fires), then
    // flips true after handleAck derives the shared key.
    let browserKey: Awaited<ReturnType<typeof buildSessionKey>> | null = null;
    const browserDriver: DesktopE2eeDriver = {
      isActive: () => browserKey !== null,
      buildHello: vi.fn(async (terminalId: string) => ({
        terminalId,
        ecdhPublicKey: browser.ecdhPublicKey,
        signature: browser.signature,
      })),
      handleAck: async (_ack: unknown) => {
        browserKey = await buildSessionKey({
          myEcdhPrivateKey: browser.ecdhPrivateKey,
          peerEcdhPublicKeySpkiBase64: agent.ecdhPublicKey,
          peerBindingSignature: agent.signature,
          peerSigningPublicKey: agent.peerSigningPublicKey,
          sessionId: 'sess-1',
        });
      },
      encrypt: (data) => browserKey!.encrypt(data),
      decrypt: (data) => browserKey!.decrypt(data),
    };

    // Drive the hello/ack through the REAL client path (emit a desktop-e2ee-ack),
    // mirroring the terminal-core T5-R1 discipline — not by calling handleAck.
    const mock = mockPeer();
    const client = new DesktopClient(
      'agent-1',
      mock.peer,
      undefined,
      browserDriver,
    );
    const started = client.start();
    mock.emitTrack(fakeTrack, fakeStreams);
    await started;
    mock.setControlState('open');

    // Wait for the hello frame to be emitted by negotiateE2ee.
    const start = Date.now();
    while (
      !mockSendJson.mock.calls.some((c) => c[1] === 'desktop-e2ee-hello') &&
      Date.now() - start < 2000
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const helloFrame = mockSendJson.mock.calls.find(
      (c) => c[1] === 'desktop-e2ee-hello',
    );
    expect(helloFrame).toBeDefined();
    const hello = helloFrame![2] as {
      terminalId: string;
      ecdhPublicKey: string;
      signature: string;
    };

    // Build the agent-side mirrored key from the browser's advertised ECDH key.
    const agentKey = await buildSessionKey({
      myEcdhPrivateKey: agent.ecdhPrivateKey,
      peerEcdhPublicKeySpkiBase64: hello.ecdhPublicKey,
      peerBindingSignature: hello.signature,
      peerSigningPublicKey: browser.peerSigningPublicKey,
      sessionId: 'sess-1',
    });

    // Emit the ack through the control channel so the client's handleAck runs.
    const ack = {
      terminalId: hello.terminalId,
      ecdhPublicKey: agent.ecdhPublicKey,
      signature: agent.signature,
    };
    mock.emitControl({
      type: 'desktop-e2ee-ack',
      channel: 'control',
      payload: ack,
      timestamp: 1,
    });

    // Wait for the browser-side key to activate.
    while (!browserKey && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(browserKey).not.toBeNull();

    // Now sentInputs must be encrypted.
    const event: DesktopInput = {
      kind: 'pointer-button',
      button: 'left',
      pressed: true,
      x: 0.3,
      y: 0.7,
    };
    mockSendJson.mockClear();
    client.sendInput(event);

    // Wait for the encrypted frame.
    let waited = 0;
    while (
      !mockSendJson.mock.calls.some((c) => c[1] === 'desktop-input') &&
      waited < 2000
    ) {
      await new Promise((r) => setTimeout(r, 5));
      waited += 5;
    }

    const inputFrame = mockSendJson.mock.calls.find(
      (c) => c[1] === 'desktop-input',
    );
    expect(inputFrame).toBeDefined();
    const payload = inputFrame![2] as { data: string };

    // The payload is { data: base64([12B IV][ct||16B tag]) }.
    const framed = Uint8Array.from(Buffer.from(payload.data, 'base64'));
    const decrypted = await agentKey.decrypt(framed);
    const json = new TextDecoder().decode(decrypted);
    expect(JSON.parse(json)).toEqual(event);

    client.close();
  });

  it('isolates failures: a throwing encrypt surfaces an error but unblocks later sends', async () => {
    // T6-C failure isolation: when encrypt() throws on the first call, the
    // .catch on sendChain must (a) forward the error and (b) NOT poison the
    // chain — the second send must still be delivered.
    const browser = await makePeerKeys('sess-fail');
    const agent = await makePeerKeys('sess-fail');

    let browserKey: Awaited<ReturnType<typeof buildSessionKey>> | null = null;
    let encryptCalls = 0;
    const errors: string[] = [];
    const browserDriver: DesktopE2eeDriver = {
      isActive: () => browserKey !== null,
      buildHello: vi.fn(async (terminalId: string) => ({
        terminalId,
        ecdhPublicKey: browser.ecdhPublicKey,
        signature: browser.signature,
      })),
      handleAck: async (_ack: unknown) => {
        browserKey = await buildSessionKey({
          myEcdhPrivateKey: browser.ecdhPrivateKey,
          peerEcdhPublicKeySpkiBase64: agent.ecdhPublicKey,
          peerBindingSignature: agent.signature,
          peerSigningPublicKey: agent.peerSigningPublicKey,
          sessionId: 'sess-fail',
        });
      },
      encrypt: vi.fn(async (data: Uint8Array) => {
        encryptCalls++;
        if (encryptCalls === 1) throw new Error('boom on first encrypt');
        return browserKey!.encrypt(data);
      }),
      decrypt: (data) => browserKey!.decrypt(data),
    };

    const mock = mockPeer();
    const client = new DesktopClient(
      'agent-1',
      mock.peer,
      undefined,
      browserDriver,
    );
    client.onError((msg) => errors.push(msg));
    const started = client.start();
    mock.emitTrack(fakeTrack, fakeStreams);
    await started;
    mock.setControlState('open');

    // Hello + ack to activate.
    const start = Date.now();
    while (
      !mockSendJson.mock.calls.some((c) => c[1] === 'desktop-e2ee-hello') &&
      Date.now() - start < 2000
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const hello = mockSendJson.mock
      .calls.find((c) => c[1] === 'desktop-e2ee-hello')!
      [2] as { terminalId: string; ecdhPublicKey: string; signature: string };
    mock.emitControl({
      type: 'desktop-e2ee-ack',
      channel: 'control',
      payload: {
        terminalId: hello.terminalId,
        ecdhPublicKey: agent.ecdhPublicKey,
        signature: agent.signature,
      },
      timestamp: 1,
    });
    while (!browserKey && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(browserKey).not.toBeNull();

    // Two discrete inputs: first encrypt throws, second must still deliver.
    mockSendJson.mockClear();
    const first: DesktopInput = {
      kind: 'pointer-button',
      button: 'left',
      pressed: true,
      x: 0.1,
      y: 0.1,
    };
    const second: DesktopInput = {
      kind: 'key',
      code: 'KeyA',
      pressed: true,
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    };

    let encryptedCount = 0;
    mockSendJson.mockImplementation((_label, type, _payload) => {
      if (type === 'desktop-input') {
        encryptedCount++;
      }
    });

    client.sendInput(first);
    client.sendInput(second);

    const waitStart = Date.now();
    while (encryptedCount < 1 && Date.now() - waitStart < 2000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(encryptedCount).toBe(1);

    // The error listener must have received the first call's failure.
    const encryptErrors = errors.filter((m) => m.includes('encrypt'));
    expect(encryptErrors.length).toBeGreaterThanOrEqual(1);
    expect(encryptErrors[0]).toMatch(/encrypt.*failed/i);

    client.close();
  });

  it('preserves send order via the sendChain (T6-C: never reorder)', async () => {
    // T6-C ordering: encrypt() resolves in reverse order (first delayed longer
    // than second), but the frames must still be sent in call order.
    const browser = await makePeerKeys('sess-order');
    const agent = await makePeerKeys('sess-order');

    let browserKey: Awaited<ReturnType<typeof buildSessionKey>> | null = null;
    let encryptCalls = 0;
    const browserDriver: DesktopE2eeDriver = {
      isActive: () => browserKey !== null,
      buildHello: vi.fn(async (terminalId: string) => ({
        terminalId,
        ecdhPublicKey: browser.ecdhPublicKey,
        signature: browser.signature,
      })),
      handleAck: async (_ack: unknown) => {
        browserKey = await buildSessionKey({
          myEcdhPrivateKey: browser.ecdhPrivateKey,
          peerEcdhPublicKeySpkiBase64: agent.ecdhPublicKey,
          peerBindingSignature: agent.signature,
          peerSigningPublicKey: agent.peerSigningPublicKey,
          sessionId: 'sess-order',
        });
      },
      encrypt: vi.fn(async (data: Uint8Array) => {
        encryptCalls++;
        // First call delayed longer (50ms); second resolves quicker (5ms).
        const delay = encryptCalls === 1 ? 50 : 5;
        await new Promise((r) => setTimeout(r, delay));
        return browserKey!.encrypt(data);
      }),
      decrypt: (data) => browserKey!.decrypt(data),
    };

    const mock = mockPeer();
    const client = new DesktopClient(
      'agent-1',
      mock.peer,
      undefined,
      browserDriver,
    );
    const started = client.start();
    mock.emitTrack(fakeTrack, fakeStreams);
    await started;
    mock.setControlState('open');

    // Hello + ack to activate.
    const start = Date.now();
    while (
      !mockSendJson.mock.calls.some((c) => c[1] === 'desktop-e2ee-hello') &&
      Date.now() - start < 2000
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const hello = mockSendJson.mock
      .calls.find((c) => c[1] === 'desktop-e2ee-hello')!
      [2] as { terminalId: string; ecdhPublicKey: string; signature: string };
    const agentKey = await buildSessionKey({
      myEcdhPrivateKey: agent.ecdhPrivateKey,
      peerEcdhPublicKeySpkiBase64: hello.ecdhPublicKey,
      peerBindingSignature: hello.signature,
      peerSigningPublicKey: browser.peerSigningPublicKey,
      sessionId: 'sess-order',
    });
    mock.emitControl({
      type: 'desktop-e2ee-ack',
      channel: 'control',
      payload: {
        terminalId: hello.terminalId,
        ecdhPublicKey: agent.ecdhPublicKey,
        signature: agent.signature,
      },
      timestamp: 1,
    });
    while (!browserKey && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(browserKey).not.toBeNull();

    // Two distinct inputs back-to-back.
    mockSendJson.mockClear();
    const first: DesktopInput = {
      kind: 'pointer-button',
      button: 'left',
      pressed: true,
      x: 0.1,
      y: 0.1,
    };
    const second: DesktopInput = {
      kind: 'pointer-button',
      button: 'right',
      pressed: true,
      x: 0.9,
      y: 0.9,
    };

    client.sendInput(first);
    client.sendInput(second);

    // Collect encrypted frames in send order.
    const waitStart = Date.now();
    let inputFrames: Array<[string, string, unknown]> = [];
    while (inputFrames.length < 2 && Date.now() - waitStart < 2000) {
      inputFrames = mockSendJson.mock.calls.filter(
        (c) => c[1] === 'desktop-input',
      ) as Array<[string, string, unknown]>;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(inputFrames).toHaveLength(2);

    const framed0 = Uint8Array.from(
      Buffer.from((inputFrames[0]![2] as { data: string }).data, 'base64'),
    );
    const framed1 = Uint8Array.from(
      Buffer.from((inputFrames[1]![2] as { data: string }).data, 'base64'),
    );
    const dec0 = JSON.parse(
      new TextDecoder().decode(await agentKey.decrypt(framed0)),
    );
    const dec1 = JSON.parse(
      new TextDecoder().decode(await agentKey.decrypt(framed1)),
    );
    // Frames must arrive in call order despite reverse-delay encrypt resolve.
    expect(dec0).toEqual(first);
    expect(dec1).toEqual(second);

    client.close();
  });

  it('non-input control types stay plaintext even when e2ee is active', async () => {
    const driver = stubDriver();
    driver.activate(); // isActive === true, but select/setBitrate must not encrypt
    const { client, setControlState } = await connected(undefined, driver);
    setControlState('open');

    client.selectSource('monitor:1');
    client.setBitrate(2_000_000);

    expect(mockSendJson).toHaveBeenCalledWith('control', 'desktop-select', {
      sourceId: 'monitor:1',
    });
    expect(mockSendJson).toHaveBeenCalledWith('control', 'desktop-bitrate', {
      bitrateBps: 2_000_000,
    });
    // No { data: base64 } shape on these control types.
    for (const call of mockSendJson.mock.calls) {
      if (call[1] === 'desktop-select' || call[1] === 'desktop-bitrate') {
        expect(call[2]).not.toHaveProperty('data');
      }
    }
    client.close();
  });
});

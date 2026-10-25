import { describe, expect, it, vi } from 'vitest';
import { DesktopClient } from '../src/client';
import type {
  DesktopCursorPayload,
  DesktopSourceInfo,
  DesktopSourcesPayload,
  DesktopStats,
} from '@ponter/shared';
import type {
  MediaStreamLike,
  MediaStreamTrackLike,
  PeerConnection,
} from '@ponter/webrtc-core';
import {
  buildCursorFrame,
  buildSourcesFrame,
  buildStatsFrame,
} from '../../../apps/agent/src/desktop/frames';

const fakeTrack: MediaStreamTrackLike = { kind: 'video' };
const fakeStreams: MediaStreamLike[] = [];

function mockPeer() {
  let trackHandler:
    ((t: MediaStreamTrackLike, s: MediaStreamLike[]) => void) | null = null;
  let controlHandler: ((msg: unknown) => void) | null = null;

  const peer = {
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onRemoteTrack: vi.fn(
      (handler: (t: MediaStreamTrackLike, s: MediaStreamLike[]) => void) => {
        trackHandler = handler;
        return vi.fn();
      },
    ),
    onConnectionStateChange: vi.fn(() => vi.fn()),
    dataChannels: {
      hasChannel: vi.fn(() => true),
      getChannel: vi.fn(() => ({ label: 'control', readyState: 'open' })),
      onMessage: vi.fn((_label: string, handler: (msg: unknown) => void) => {
        controlHandler = handler;
        return vi.fn();
      }),
      sendJson: vi.fn(),
    },
    waitForChannel: vi.fn(async () => ({
      label: 'control',
      readyState: 'open',
    })),
    options: { sessionId: 'test-session' },
    peer: {
      getVideoReceiver: vi.fn().mockReturnValue(undefined),
    },
  } as unknown as PeerConnection;

  return {
    peer,
    emitTrack: (t: MediaStreamTrackLike, s: MediaStreamLike[]) =>
      trackHandler?.(t, s),
    // Emulates webrtc-core data-channel typed listener JSON.parse dispatch
    emitControlRaw: (raw: string) => {
      const parsed = JSON.parse(raw) as { type?: string; payload?: unknown };
      if (parsed && typeof parsed.type === 'string') {
        controlHandler?.(parsed);
      }
    },
  };
}

async function connected() {
  const mock = mockPeer();
  const client = new DesktopClient('agent-1', mock.peer);
  const started = client.start();
  mock.emitTrack(fakeTrack, fakeStreams);
  await started;
  return { ...mock, client };
}

describe('DesktopClient composition with agent desktop frames', () => {
  it('delivers stats frame built by agent to onStats with all required fields intact', async () => {
    const { client, emitControlRaw } = await connected();
    const statsReceived: DesktopStats[] = [];
    client.onStats((s) => statsReceived.push(s));

    const statsInput: DesktopStats = {
      width: 1920,
      height: 1080,
      fps: 30,
      targetBitrateBps: 4_000_000,
      encodeMsP50: 7.2,
      captureMsP50: 3.1,
    };
    const raw = buildStatsFrame(statsInput as never, 1000);
    emitControlRaw(raw);

    expect(statsReceived).toHaveLength(1);
    expect(statsReceived[0]).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      targetBitrateBps: 4_000_000,
    });
  });

  it('delivers sources frame built by agent to onSources with sources list and inputEnabled', async () => {
    const { client, emitControlRaw } = await connected();
    const sourcesReceived: DesktopSourcesPayload[] = [];
    client.onSources((s) => sourcesReceived.push(s));

    const sourceList: DesktopSourceInfo[] = [
      {
        id: 'monitor:0',
        kind: 'monitor',
        name: 'DP-1',
        width: 1920,
        height: 1080,
        x: 0,
        y: 0,
        scaleFactor: 1,
        rotation: 0,
        isPrimary: true,
        default: true,
      },
    ];
    // Under BASE, buildSourcesFrame only accepts 1 object param; passing 5 args
    const raw = buildSourcesFrame(sourceList as never, true, true, true, 1000);
    emitControlRaw(raw);

    expect(sourcesReceived).toHaveLength(1);
    expect(sourcesReceived[0]?.sources).toEqual(sourceList);
    expect(sourcesReceived[0]?.inputEnabled).toBe(true);
  });

  it('delivers cursor frame built by agent to onCursor with seq intact', async () => {
    const { client, emitControlRaw } = await connected();
    const cursorReceived: DesktopCursorPayload[] = [];
    client.onCursor((c) => cursorReceived.push(c));

    const cursorInput: DesktopCursorPayload = {
      x: 0.5,
      y: 0.5,
      visible: true,
      seq: 42,
    };
    const raw = buildCursorFrame(cursorInput as never, 1000);
    emitControlRaw(raw);

    expect(cursorReceived).toHaveLength(1);
    expect(cursorReceived[0]?.seq).toBe(42);
  });
});

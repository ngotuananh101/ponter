// apps/agent/test/desktop/frames.test.ts
import type { DesktopSourceInfo } from '@ponter/shared';
import { describe, expect, it } from 'vitest';
import {
  buildCursorFrame,
  buildSourcesFrame,
  buildStatsFrame,
} from '../../src/desktop/frames.js';

const parse = (text: string) => JSON.parse(text);

describe('buildStatsFrame', () => {
  it('emits the DataChannelMessage envelope on the control channel', () => {
    const frame = parse(
      buildStatsFrame(
        {
          width: 1920,
          height: 1080,
          fps: 30,
          targetBitrateBps: 4_000_000,
        },
        12_345,
      ),
    );
    expect(frame.type).toBe('desktop-stats');
    expect(frame.channel).toBe('control');
    expect(frame.timestamp).toBe(12_345);
  });

  it('carries the stats fields the browser requires', () => {
    const frame = parse(
      buildStatsFrame(
        {
          width: 1920,
          height: 1080,
          fps: 30,
          targetBitrateBps: 4_000_000,
        },
        1,
      ),
    );
    expect(frame.payload).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      targetBitrateBps: 4_000_000,
    });
  });

  it('rounds the two p50s to one decimal place', () => {
    const frame = parse(
      buildStatsFrame(
        {
          width: 1280,
          height: 720,
          fps: 30,
          targetBitrateBps: 1,
          encodeMsP50: 7.25,
          captureMsP50: 3.04,
        },
        1,
      ),
    );
    expect(frame.payload.encodeMsP50).toBe(7.3);
    expect(frame.payload.captureMsP50).toBe(3);
  });

  it('omits every absent optional stats field', () => {
    const frame = parse(
      buildStatsFrame(
        {
          width: 1920,
          height: 1080,
          fps: 30,
          targetBitrateBps: 6_000_000,
        },
        1,
      ),
    );
    for (const key of [
      'status',
      'frameSeq',
      'captureMsP50',
      'encodeMsP50',
      'frameSamples',
    ]) {
      expect(key in frame.payload).toBe(false);
    }
  });

  it('carries the optional stats fields when they are set, and omits only the unset one', () => {
    const frame = parse(
      buildStatsFrame(
        {
          width: 1280,
          height: 720,
          fps: 30,
          targetBitrateBps: 4_000_000,
          status: {
            kind: 'quality-downgraded',
            detail: '720p (quality downgraded)',
          },
          frameSeq: 42,
          encodeMsP50: 11,
          frameSamples: [{ seq: 42, captureEpochMs: 1000, encodeMs: 11 }],
        },
        3,
      ),
    );
    expect(frame.payload.status).toEqual({
      kind: 'quality-downgraded',
      detail: '720p (quality downgraded)',
    });
    expect(frame.payload.frameSeq).toBe(42);
    expect(frame.payload.frameSamples).toEqual([
      { seq: 42, captureEpochMs: 1000, encodeMs: 11 },
    ]);
    expect('captureMsP50' in frame.payload).toBe(false);
  });
});

describe('buildCursorFrame', () => {
  it('emits the envelope with x, y, visible and seq', () => {
    const frame = parse(
      buildCursorFrame(
        {
          x: 0.25,
          y: 0.75,
          visible: true,
          seq: 7,
        },
        1_700_000_000,
      ),
    );
    expect(frame).toMatchObject({
      type: 'desktop-cursor',
      channel: 'control',
      timestamp: 1_700_000_000,
      payload: {
        x: 0.25,
        y: 0.75,
        visible: true,
        seq: 7,
      },
    });
  });

  it('omits shape when the cursor has none', () => {
    const frame = parse(
      buildCursorFrame(
        {
          x: 0,
          y: 0,
          visible: false,
          seq: 1,
        },
        1,
      ),
    );
    expect('shape' in frame.payload).toBe(false);
  });

  it('emits the shape record when one is set', () => {
    const frame = parse(
      buildCursorFrame(
        {
          x: 0,
          y: 0,
          visible: true,
          seq: 0,
          shape: {
            png: 'iVBORw0KGgo=',
            hotspotX: 4,
            hotspotY: 8,
            serial: 42,
          },
        },
        1,
      ),
    );
    expect(frame.payload.shape).toEqual({
      png: 'iVBORw0KGgo=',
      hotspotX: 4,
      hotspotY: 8,
      serial: 42,
    });
  });

  it('stamps lastInputSeq on the wire when one is set', () => {
    const frame = parse(
      buildCursorFrame(
        {
          x: 100,
          y: 200,
          visible: true,
          seq: 1,
          lastInputSeq: 3,
        },
        1,
      ),
    );
    expect(frame.payload).toMatchObject({ lastInputSeq: 3 });
  });

  it('omits lastInputSeq from the wire when none is set', () => {
    const frame = parse(
      buildCursorFrame(
        {
          x: 0,
          y: 0,
          visible: false,
          seq: 1,
        },
        1,
      ),
    );
    expect('lastInputSeq' in frame.payload).toBe(false);
  });
});

describe('buildSourcesFrame', () => {
  it('emits the DesktopSourcesPayload shape', () => {
    const frame = parse(buildSourcesFrame([], true, true, true, 7));
    expect(frame.type).toBe('desktop-sources');
    expect(frame.channel).toBe('control');
    expect(frame.timestamp).toBe(7);
    expect(frame.payload).toMatchObject({
      sources: [],
      inputEnabled: true,
      peerVerified: true,
      cursorInFrame: true,
    });
  });

  it('renders inputEnabled, peerVerified and cursorInFrame in both directions', () => {
    const t = parse(buildSourcesFrame([], true, true, true, 1));
    expect(t.payload.inputEnabled).toBe(true);
    expect(t.payload.peerVerified).toBe(true);
    expect(t.payload.cursorInFrame).toBe(true);

    const f = parse(buildSourcesFrame([], false, false, false, 1));
    expect(f.payload.inputEnabled).toBe(false);
    expect(f.payload.peerVerified).toBe(false);
    expect(f.payload.cursorInFrame).toBe(false);
  });

  it('carries every DesktopSourceInfo field with the camelCase spelling', () => {
    const source: DesktopSourceInfo = {
      id: 'test:0',
      kind: 'monitor',
      name: 'Test pattern',
      width: 1280,
      height: 720,
      x: 0,
      y: 0,
      scaleFactor: 1.0,
      rotation: 0.0,
      isPrimary: true,
      default: true,
    };
    const frame = parse(buildSourcesFrame([source], true, true, true, 1));
    expect(frame.payload.sources[0]).toEqual(source);
    expect('scale_factor' in frame.payload.sources[0]).toBe(false);
  });

  it('carries multi-entry sources including windows and monitors', () => {
    const monitor: DesktopSourceInfo = {
      id: 'monitor:0',
      kind: 'monitor',
      name: 'Display 1',
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
      scaleFactor: 1.0,
      rotation: 0.0,
      isPrimary: true,
      default: true,
    };
    const window: DesktopSourceInfo = {
      id: 'window:123',
      kind: 'window',
      name: 'Terminal',
      width: 800,
      height: 600,
      x: 100,
      y: 100,
      scaleFactor: 1.0,
      rotation: 0.0,
      isPrimary: false,
      default: false,
    };
    const frame = parse(
      buildSourcesFrame([monitor, window], true, true, true, 1),
    );
    expect(frame.payload.sources).toHaveLength(2);
    expect(frame.payload.sources[0]).toEqual(monitor);
    expect(frame.payload.sources[1]).toEqual(window);
  });
});

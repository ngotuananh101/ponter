// apps/agent/test/desktop/frames.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildCursorFrame,
  buildSourcesFrame,
  buildStatsFrame,
} from '../../src/desktop/frames.js';

const parse = (text: string) => JSON.parse(text);

describe('buildStatsFrame', () => {
  it('emits the documented field names', () => {
    const frame = parse(
      buildStatsFrame({
        seq: 10,
        fps: 58.5,
        bitrate: 4_000_000,
        encodeMsP50: 7.2,
        captureMsP50: 3.1,
        skippedFrames: 12,
        profile: '1080p30',
      }),
    );
    expect(frame).toMatchObject({
      type: 'desktop-stats',
      data: {
        seq: 10,
        fps: 58.5,
        bitrate: 4_000_000,
        encodeMsP50: 7.2,
        captureMsP50: 3.1,
        skippedFrames: 12,
        profile: '1080p30',
      },
    });
  });

  it('rounds the two p50s to one decimal place', () => {
    const frame = parse(
      buildStatsFrame({
        seq: 1,
        fps: 30,
        bitrate: 1,
        encodeMsP50: 7.25,
        captureMsP50: 3.04,
        skippedFrames: 0,
        profile: '720p30',
      }),
    );
    expect(frame.data.encodeMsP50).toBe(7.3);
    expect(frame.data.captureMsP50).toBe(3);
  });
});

describe('buildCursorFrame', () => {
  it('emits x, y, visible and shape', () => {
    const frame = parse(
      buildCursorFrame({ x: 100, y: 200, visible: true, shape: 'default' }),
    );
    expect(frame).toEqual({
      type: 'desktop-cursor',
      data: { x: 100, y: 200, visible: true, shape: 'default' },
    });
  });

  it('emits visible=false with a null shape rather than omitting the field', () => {
    // The browser's cursor layer reads `data.shape` unconditionally; a missing
    // field there draws the previous cursor shape at the new position.
    const frame = parse(
      buildCursorFrame({ x: 0, y: 0, visible: false, shape: null }),
    );
    expect(frame.data).toEqual({ x: 0, y: 0, visible: false, shape: null });
  });

  it('stamps lastInputSeq on the wire when one is set', () => {
    // ADR-47's echo: the browser's latency meter reads this field. The Rust
    // pins `lastInputSeq: 3` on the payload (`desktop.rs:3758`).
    const frame = parse(
      buildCursorFrame({
        x: 100,
        y: 200,
        visible: true,
        shape: 'default',
        lastInputSeq: 3,
      }),
    );
    expect(frame.data).toMatchObject({ lastInputSeq: 3 });
  });

  it('omits lastInputSeq from the wire when none is set', () => {
    // Mirrors `frame_desktop_cursor_omits_last_input_seq_when_none`
    // (`desktop.rs:3766-3786`): `skip_serializing_if` on `None` — the field is
    // absent from the JSON, not null.
    const frame = parse(
      buildCursorFrame({ x: 0, y: 0, visible: false, shape: null }),
    );
    expect('lastInputSeq' in frame.data).toBe(false);
  });
});

describe('buildSourcesFrame', () => {
  it('lists monitors and windows with their ids', () => {
    const frame = parse(
      buildSourcesFrame({
        monitors: [
          { id: '1', name: 'DP-1', width: 1920, height: 1080, primary: true },
        ],
        windows: [{ id: '0x40', title: 'Editor' }],
      }),
    );
    expect(frame.type).toBe('desktop-sources');
    expect(frame.data.monitors[0]).toMatchObject({ id: '1', primary: true });
    expect(frame.data.windows[0]).toMatchObject({
      id: '0x40',
      title: 'Editor',
    });
  });
});

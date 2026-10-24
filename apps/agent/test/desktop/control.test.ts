// apps/agent/test/desktop/control.test.ts
import { describe, expect, it } from 'vitest';
import {
  MAX_BITRATE,
  MIN_BITRATE,
  clampBitrate,
  decodeDesktopSelect,
  decodeStreamControl,
  gopForFps,
} from '../../src/desktop/control.js';

const frame = (payload: unknown) =>
  new TextEncoder().encode(JSON.stringify(payload));

describe('clampBitrate', () => {
  it('clamps to [250 kbps, 20 Mbps]', () => {
    expect(clampBitrate(1_000_000)).toBe(1_000_000);
    expect(clampBitrate(1)).toBe(MIN_BITRATE);
    expect(clampBitrate(Number.MAX_SAFE_INTEGER)).toBe(MAX_BITRATE);
  });

  it('rounds to an integer', () => {
    expect(clampBitrate(1_000_000.6)).toBe(1_000_001);
  });
});

describe('decodeStreamControl', () => {
  it('decodes the four control kinds', () => {
    expect(
      decodeStreamControl(frame({ type: 'stream-control', action: 'pause' })),
    ).toEqual({ kind: 'pause' });
    expect(
      decodeStreamControl(frame({ type: 'stream-control', action: 'resume' })),
    ).toEqual({ kind: 'resume' });
    expect(
      decodeStreamControl(frame({ type: 'stream-control', action: 'stop' })),
    ).toEqual({ kind: 'stop' });
  });

  it('clamps a bitrate inside the decode, not at the call site', () => {
    // The clamp has to live here: three call sites exist (initial apply, live
    // retarget, resume) and a clamp at one of them is a clamp at none.
    const control = decodeStreamControl(
      frame({
        type: 'stream-control',
        action: 'set-bitrate',
        bitrate: 99_000_000,
      }),
    );
    expect(control).toEqual({ kind: 'bitrate', bitrate: MAX_BITRATE });
  });

  it('decodes a quality change', () => {
    expect(
      decodeStreamControl(
        frame({
          type: 'stream-control',
          action: 'set-quality',
          profile: '720p30',
        }),
      ),
    ).toEqual({
      kind: 'quality',
      profile: '720p30',
    });
  });

  it('rejects an unknown profile instead of defaulting', () => {
    expect(
      decodeStreamControl(
        frame({
          type: 'stream-control',
          action: 'set-quality',
          profile: '4k120',
        }),
      ),
    ).toBeNull();
  });

  it('rejects an unknown action and malformed JSON', () => {
    expect(
      decodeStreamControl(frame({ type: 'stream-control', action: 'explode' })),
    ).toBeNull();
    expect(decodeStreamControl(new TextEncoder().encode('nope'))).toBeNull();
  });
});

describe('decodeDesktopSelect', () => {
  it('decodes monitor, window and test sources', () => {
    expect(
      decodeDesktopSelect(
        frame({ type: 'desktop-select', source: { kind: 'monitor', id: '1' } }),
      ),
    ).toEqual({
      kind: 'monitor',
      id: '1',
    });
    expect(
      decodeDesktopSelect(
        frame({
          type: 'desktop-select',
          source: { kind: 'window', id: '0x40' },
        }),
      ),
    ).toEqual({
      kind: 'window',
      id: '0x40',
    });
    expect(
      decodeDesktopSelect(
        frame({ type: 'desktop-select', source: { kind: 'test' } }),
      ),
    ).toEqual({ kind: 'test' });
  });

  it('rejects a monitor with no id or an empty one', () => {
    // `value.id === ''` is not decoration: an empty source id names no source,
    // and the plan's decoder refuses it rather than handing the session loop a
    // selection that can never resolve. Both polarities are pinned here because
    // the missing-key case and the empty-string case are separate guards.
    expect(
      decodeDesktopSelect(
        frame({ type: 'desktop-select', source: { kind: 'monitor' } }),
      ),
    ).toBeNull();
    expect(
      decodeDesktopSelect(
        frame({ type: 'desktop-select', source: { kind: 'monitor', id: '' } }),
      ),
    ).toBeNull();
    expect(
      decodeDesktopSelect(
        frame({ type: 'desktop-select', source: { kind: 'window', id: '' } }),
      ),
    ).toBeNull();
  });
});

describe('gopForFps', () => {
  it('is two seconds of frames, never zero', () => {
    expect(gopForFps(60)).toBe(120);
    expect(gopForFps(30)).toBe(60);
    expect(gopForFps(0.2)).toBe(1);
  });
});

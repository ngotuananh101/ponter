import { describe, it, expect } from 'vitest';
import type {
  DesktopCursorPayload,
  DesktopInput,
  DesktopShape,
  DesktopSourceInfo,
  DesktopSourcesPayload,
  DesktopStats,
  KeyModifiers,
} from '../src';

describe('Desktop wire types', () => {
  it('instantiates a valid DesktopSourceInfo', () => {
    const source: DesktopSourceInfo = {
      id: 'monitor:1',
      kind: 'monitor',
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
    expect(source.kind).toBe('monitor');
    expect(source.default).toBe(true);
  });

  it('instantiates a valid DesktopStats without status', () => {
    const stats: DesktopStats = {
      width: 1920,
      height: 1080,
      fps: 30,
      targetBitrateBps: 6_000_000,
    };
    expect(stats.status).toBeUndefined();
  });

  it('carries a select-refused status when the agent refuses a selection', () => {
    const stats: DesktopStats = {
      width: 1920,
      height: 1080,
      fps: 30,
      targetBitrateBps: 6_000_000,
      status: { kind: 'select-refused', detail: 'unknown source id' },
    };
    expect(stats.status?.kind).toBe('select-refused');
  });
});

describe('Desktop input wire types (Week 9, spec §2.2)', () => {
  it('narrows the DesktopInput union on kind', () => {
    const mods: KeyModifiers = {
      ctrl: false,
      alt: false,
      shift: true,
      meta: false,
    };
    const events: DesktopInput[] = [
      { kind: 'pointer-move', x: 0.5, y: 0.25 },
      {
        kind: 'pointer-button',
        button: 'left',
        pressed: true,
        x: 0.5,
        y: 0.25,
      },
      { kind: 'wheel', dx: 0, dy: -1, x: 0.5, y: 0.25 },
      { kind: 'key', code: 'ShiftLeft', pressed: true, modifiers: mods },
      { kind: 'text', text: 'hi' },
    ];
    // Exhaustiveness: a `switch` on `kind` must see exactly five arms.
    const seen = new Set(events.map((e) => e.kind));
    expect(seen).toEqual(
      new Set(['pointer-move', 'pointer-button', 'wheel', 'key', 'text']),
    );
    const move = events[0];
    if (move?.kind === 'pointer-move') expect(move.x).toBe(0.5);
  });

  it('instantiates a valid DesktopCursorPayload with optional shape and lastInputSeq', () => {
    const cursor: DesktopCursorPayload = {
      x: 0.5,
      y: 0.25,
      visible: true,
      seq: 42,
      lastInputSeq: 10,
      shape: {
        png: 'iVBORw0KGgo...',
        hotspotX: 0,
        hotspotY: 0,
        serial: 1,
      },
    };
    expect(cursor.visible).toBe(true);
    expect(cursor.shape?.serial).toBe(1);
  });

  it('supports DesktopStats with latency timing fields and sample ring', () => {
    const stats: DesktopStats = {
      width: 1920,
      height: 1080,
      fps: 60,
      targetBitrateBps: 6_000_000,
      frameSeq: 120,
      captureMsP50: 3.5,
      encodeMsP50: 4.2,
      frameSamples: [{ seq: 120, captureEpochMs: 1700000000000, encodeMs: 4 }],
    };
    expect(stats.captureMsP50).toBe(3.5);
    expect(stats.frameSamples).toHaveLength(1);
  });

  it('allows optional seq on pointer DesktopInput variants', () => {
    const move: DesktopInput = {
      kind: 'pointer-move',
      x: 0.1,
      y: 0.2,
      seq: 99,
    };
    if (move.kind === 'pointer-move') {
      expect(move.seq).toBe(99);
    }
  });

  it('supports DesktopShape with png, hotspot, and serial', () => {
    const shape: DesktopShape = {
      png: 'base64data',
      hotspotX: 2,
      hotspotY: 3,
      serial: 7,
    };
    expect(shape.serial).toBe(7);
    expect(shape.hotspotX).toBe(2);
  });

  it('carries cursorInFrame on DesktopSourcesPayload', () => {
    const payload: DesktopSourcesPayload = {
      sources: [],
      inputEnabled: false,
      peerVerified: true,
      cursorInFrame: true,
    };
    expect(payload.cursorInFrame).toBe(true);
  });

  it('carries inputEnabled and peerVerified alongside the Week 8 sources', () => {
    const payload: DesktopSourcesPayload = {
      sources: [
        {
          id: 'monitor:1',
          kind: 'monitor',
          name: 'eDP-1',
          width: 1920,
          height: 1080,
          x: 0,
          y: 0,
          scaleFactor: 1,
          rotation: 0,
          isPrimary: true,
          default: true,
        },
      ],
      inputEnabled: false,
      peerVerified: true,
    };
    expect(payload.inputEnabled).toBe(false);
    expect(payload.peerVerified).toBe(true);
    expect(payload.sources[0]?.default).toBe(true);
  });
});

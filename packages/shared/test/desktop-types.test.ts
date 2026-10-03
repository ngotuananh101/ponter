import { describe, it, expect } from 'vitest';
import type {
  DesktopInput,
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

  it('carries inputEnabled alongside the Week 8 sources', () => {
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
    };
    expect(payload.inputEnabled).toBe(false);
    expect(payload.sources[0]?.default).toBe(true);
  });
});

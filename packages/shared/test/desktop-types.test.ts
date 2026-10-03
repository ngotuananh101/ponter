import { describe, it, expect } from 'vitest';
import type { DesktopSourceInfo, DesktopStats } from '../src';

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

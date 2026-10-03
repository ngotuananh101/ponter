import { describe, it, expect } from 'vitest';
import { toNormalized } from '../lib/desktop-input';

// A DOMRect is a plain shape for this pure function; build one with the fields
// it reads (left/top/width/height). jsdom's DOMRect works too, but a literal
// keeps the test DOM-free.
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height }) as DOMRect;

describe('toNormalized (spec §7.1, ADR-30)', () => {
  it('maps a point through a letterbox (wide element)', () => {
    // Element 800×300, video 16:9 (1280×720). Content box is 533.33×300,
    // centred: left offset (800-533.33)/2 = 133.33.
    // A quarter into the content box: 133.33 + 0.25×533.33 = 266.67.
    const { x, y } = toNormalized(266.67, 150, rect(0, 0, 800, 300), 1280, 720);
    expect(x).toBeCloseTo(0.25, 2);
    expect(y).toBeCloseTo(0.5, 2);
  });

  it('maps through a pillarbox (tall element)', () => {
    // Element 300×800, video 16:9. Content box is 300×168.75, centred:
    // top offset (800-168.75)/2 = 315.625.
    // A quarter into the content box: 315.625 + 0.25×168.75 = 357.8125.
    const { x, y } = toNormalized(
      150,
      357.8125,
      rect(0, 0, 300, 800),
      1280,
      720,
    );
    expect(x).toBeCloseTo(0.5, 2);
    expect(y).toBeCloseTo(0.25, 2);
  });

  it('clamps a click on the black bar to the nearest edge', () => {
    // Element 300×800, video 16:9: the content box is 300×168.75 centred at
    // y = 315.625, so the bars are top/bottom. A point at y = 5 is in the top
    // bar and clamps to y = 0 instead of mapping to a negative coordinate.
    const { x, y } = toNormalized(150, 5, rect(0, 0, 300, 800), 1280, 720);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(1);
    expect(y).toBe(0);
  });

  it('accounts for the element offset on the page', () => {
    const { x } = toNormalized(
      200 + 133.33 + 266.67,
      100 + 150,
      rect(200, 100, 800, 300),
      1280,
      720,
    );
    expect(x).toBeCloseTo(0.5, 2);
  });
});

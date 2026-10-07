import { describe, it, expect } from 'vitest';
import {
  toNormalized,
  contentBox,
  toClient,
  extrapolateCursor,
} from '../lib/desktop-input';

// A DOMRect is a plain shape for this pure function; build one with the fields
// it reads (left/top/width/height). jsdom's DOMRect works too, but a literal
// keeps the test DOM-free.
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height }) as DOMRect;

const P = (x: number, y: number, time: number) => ({ x, y, time });

describe('contentBox (ADR-45)', () => {
  it('computes a pillarbox box for a wide element (16:9 video)', () => {
    // Element 300×800, video 16:9 (1280×720).
    // contentH = 300 / (1280/720) = 168.75; contentW = 300.
    const box = contentBox(rect(0, 0, 300, 800), 1280, 720);
    expect(box.left).toBeCloseTo(0, 2);
    expect(box.top).toBeCloseTo((800 - 168.75) / 2, 2);
    expect(box.width).toBeCloseTo(300, 2);
    expect(box.height).toBeCloseTo(168.75, 2);
  });

  it('computes a letterbox box for a tall element (16:9 video)', () => {
    // Element 800×300, video 16:9 (1280×720).
    // contentW = 300 / (720/1280) = 533.333; contentH = 300.
    const box = contentBox(rect(0, 0, 800, 300), 1280, 720);
    expect(box.left).toBeCloseTo((800 - 533.333) / 2, 2);
    expect(box.top).toBeCloseTo(0, 2);
    expect(box.width).toBeCloseTo(533.333, 2);
    expect(box.height).toBeCloseTo(300, 2);
  });

  it('accounts for a non-zero element origin', () => {
    const box = contentBox(rect(200, 100, 800, 300), 1280, 720);
    expect(box.left).toBeCloseTo(200 + (800 - 533.333) / 2, 2);
    expect(box.top).toBeCloseTo(100, 2);
  });

  it('degenerate inputs return a zero box', () => {
    expect(contentBox(rect(0, 0, 0, 0), 1280, 720)).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
    expect(contentBox(rect(0, 0, 800, 300), 0, 0)).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});

describe('toClient (ADR-45)', () => {
  it('round-trips with toNormalized within 1 pixel', () => {
    const r = rect(0, 0, 800, 300);
    const vw = 1280,
      vh = 720;
    for (let i = 0; i <= 10; i++) {
      const nx = i / 10;
      for (let j = 0; j <= 10; j++) {
        const ny = j / 10;
        const c = toClient(nx, ny, r, vw, vh);
        const back = toNormalized(c.x, c.y, r, vw, vh);
        expect(back.x).toBeCloseTo(nx, 0);
        expect(back.y).toBeCloseTo(ny, 0);
      }
    }
  });

  it('returns the top-left of the content box for (0,0)', () => {
    const r = rect(0, 0, 800, 300);
    const c = toClient(0, 0, r, 1280, 720);
    const box = contentBox(r, 1280, 720);
    expect(c.x).toBeCloseTo(box.left, 2);
    expect(c.y).toBeCloseTo(box.top, 2);
  });
});

describe('extrapolateCursor (ADR-45)', () => {
  it('projects a linear trajectory for less than maxDelta', () => {
    const p0 = P(0.2, 0.2, 0);
    const p1 = P(0.4, 0.4, 50); // 0.2 per 50ms = 4 px/ms
    // target 75ms: 25ms projection → 0.4 + 0.04*25... wait, 0.2/50 = 0.004/ms
    // 0.4 + 0.004*25 = 0.5
    const result = extrapolateCursor(p0, p1, 75, 100);
    expect(result.x).toBeCloseTo(0.5, 3);
    expect(result.y).toBeCloseTo(0.5, 3);
  });

  it('clamps the projection at maxDeltaMs without overshoot', () => {
    const p0 = P(0.0, 0.0, 0);
    const p1 = P(0.1, 0.1, 50);
    // velocity = 0.002/ms; target 500ms → clamp to 100ms → 0.1 + 0.002*100 = 0.3
    const result = extrapolateCursor(p0, p1, 500, 100);
    expect(result.x).toBeCloseTo(0.3, 3);
    expect(result.y).toBeCloseTo(0.3, 3);
  });

  it('returns p1 unchanged when target is at or before p1.time', () => {
    const p0 = P(0.2, 0.2, 0);
    const p1 = P(0.4, 0.4, 50);
    const result = extrapolateCursor(p0, p1, 50, 100);
    expect(result.x).toBeCloseTo(0.4, 3);
    expect(result.y).toBeCloseTo(0.4, 3);
  });

  it('clamps the result to [0,1] in both axes', () => {
    const p0 = P(0.9, 0.9, 0);
    const p1 = P(1.0, 1.0, 50);
    const result = extrapolateCursor(p0, p1, 200, 100);
    expect(result.x).toBeLessThanOrEqual(1);
    expect(result.y).toBeLessThanOrEqual(1);
  });

  it('returns p1 position on non-finite or degenerate input', () => {
    const p0 = P(0.2, 0.2, 0);
    const p1 = P(0.4, 0.4, 50);
    // zero time delta
    expect(extrapolateCursor(p1, p1, 100, 100)).toEqual({ x: 0.4, y: 0.4 });
    // negative time delta
    expect(extrapolateCursor(p1, p0, 100, 100)).toEqual({ x: 0.2, y: 0.2 });
    // NaN inputs
    expect(
      extrapolateCursor(P(NaN, 0.2, 0), P(0.4, NaN, 50), 100, 100),
    ).toEqual({
      x: 0.4,
      y: NaN,
    });
    expect(extrapolateCursor(P(Infinity, 0.2, 0), p1, 100, 100)).toEqual({
      x: 0.4,
      y: 0.4,
    });
  });
});

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

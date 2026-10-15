import { describe, it, expect } from 'vitest';
import { ReconnectBackoff } from '../src/backoff';

describe('ReconnectBackoff', () => {
  it('follows the 200->2000ms ladder and caps at maxMs', () => {
    const b = new ReconnectBackoff({
      initialMs: 200,
      maxMs: 2000,
      jitterMs: 0,
      maxRetries: Infinity,
    });
    expect([
      b.next(),
      b.next(),
      b.next(),
      b.next(),
      b.next(),
      b.next(),
    ]).toEqual([200, 400, 800, 1600, 2000, 2000]);
  });

  it('applies symmetric jitter of +/-jitterMs around the ladder value', () => {
    const hi = new ReconnectBackoff({
      initialMs: 200,
      maxMs: 2000,
      jitterMs: 50,
      maxRetries: Infinity,
      random: () => 0.99,
    });
    expect(hi.next()).toBe(249); // 200 + round(0.99*100 - 50) = 200 + 49

    const lo = new ReconnectBackoff({
      initialMs: 200,
      maxMs: 2000,
      jitterMs: 50,
      maxRetries: Infinity,
      random: () => 0,
    });
    expect(lo.next()).toBe(150); // 200 + round(0 - 50) = 200 - 50
  });

  it('canRetry is false once maxRetries steps have been taken', () => {
    const b = new ReconnectBackoff({
      initialMs: 200,
      maxMs: 2000,
      jitterMs: 0,
      maxRetries: 2,
    });
    expect(b.canRetry()).toBe(true);
    b.next();
    expect(b.canRetry()).toBe(true);
    b.next();
    expect(b.canRetry()).toBe(false);
  });

  it('reset returns the ladder to the first step', () => {
    const b = new ReconnectBackoff({
      initialMs: 200,
      maxMs: 2000,
      jitterMs: 0,
      maxRetries: Infinity,
    });
    b.next();
    b.next();
    expect(b.attempt).toBe(2);
    b.reset();
    expect(b.attempt).toBe(0);
    expect(b.next()).toBe(200);
  });
});

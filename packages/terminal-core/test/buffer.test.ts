import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../src/buffer';

describe('RingBuffer', () => {
  it('stores and retrieves bytes within capacity', () => {
    const buffer = new RingBuffer(16);
    const data = new TextEncoder().encode('hello world');
    buffer.push(data);
    expect(new TextDecoder().decode(buffer.getAll())).toBe('hello world');
  });

  it('evicts oldest bytes when capacity exceeded', () => {
    const buffer = new RingBuffer(10);
    buffer.push(new TextEncoder().encode('123456'));
    buffer.push(new TextEncoder().encode('7890ab'));
    // total 12 bytes pushed into 10-byte buffer -> should retain last 10 bytes: '34567890ab'
    expect(new TextDecoder().decode(buffer.getAll())).toBe('34567890ab');
  });
});

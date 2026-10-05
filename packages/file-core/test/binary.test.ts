import { describe, it, expect } from 'vitest';
import { packBinaryChunk, unpackBinaryChunk } from '../src/binary';
import {
  BINARY_TYPE_DOWNLOAD_CHUNK,
  BINARY_TYPE_UPLOAD_CHUNK,
} from '@ponter/shared';

describe('Binary Chunk Framing', () => {
  it('packs and unpacks binary chunks with exact offsets', () => {
    const transferId = '12345678-1234-4234-8234-123456789abc';
    const chunkIndex = 15;
    const payload = new Uint8Array([10, 20, 30, 40]);

    const packed = packBinaryChunk(
      BINARY_TYPE_UPLOAD_CHUNK,
      transferId,
      chunkIndex,
      payload,
    );
    expect(packed.byteLength).toBe(25 + 4);

    const unpacked = unpackBinaryChunk(packed);
    expect(unpacked.type).toBe(BINARY_TYPE_UPLOAD_CHUNK);
    expect(unpacked.transferId).toBe(transferId);
    expect(unpacked.chunkIndex).toBe(chunkIndex);
    expect(Array.from(unpacked.data)).toEqual([10, 20, 30, 40]);
  });

  it('rejects frames with length < 25', () => {
    expect(() => unpackBinaryChunk(new Uint8Array(24))).toThrow(/truncated/i);
  });

  it('rejects frames with length > 25 + 32768 (oversized payload)', () => {
    expect(() => unpackBinaryChunk(new Uint8Array(25 + 32768 + 1))).toThrow(
      /oversized/i,
    );
  });

  it('accepts a frame at the exact payload cap (25 + 32768)', () => {
    const transferId = '550e8400-e29b-41d4-a716-446655440000';
    const payload = new Uint8Array(32768).fill(42);
    const packed = packBinaryChunk(
      BINARY_TYPE_DOWNLOAD_CHUNK,
      transferId,
      0,
      payload,
    );
    expect(packed.byteLength).toBe(25 + 32768);
    const unpacked = unpackBinaryChunk(packed);
    expect(unpacked.type).toBe(BINARY_TYPE_DOWNLOAD_CHUNK);
    expect(unpacked.transferId).toBe(transferId);
    expect(unpacked.chunkIndex).toBe(0);
    expect(unpacked.data.byteLength).toBe(32768);
  });
});

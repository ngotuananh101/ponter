// apps/agent/test/files/protocol.test.ts
import { describe, expect, it } from 'vitest';
import {
  decodeUploadChunk,
  encodeDownloadChunk,
  expectedChunkLen,
  frameFiles,
  partName,
  totalChunks,
} from '../../src/files/protocol.js';
import { SandboxError } from '../../src/files/sandbox.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('chunk arithmetic', () => {
  it('counts the last partial chunk', () => {
    expect(totalChunks(0)).toBe(0);
    expect(totalChunks(1)).toBe(1);
    expect(totalChunks(32768)).toBe(1);
    expect(totalChunks(32769)).toBe(2);
  });

  it('returns a full chunk except the last', () => {
    expect(expectedChunkLen(65536, 0)).toBe(32768);
    expect(expectedChunkLen(65536, 1)).toBe(32768);
    expect(expectedChunkLen(65537, 2)).toBe(1);
  });
});

describe('the binary frame', () => {
  it('round-trips through the 25-byte header', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const frame = encodeDownloadChunk(ID, 7, payload);
    expect(frame).toHaveLength(25 + 4);
    expect(frame[0]).toBe(0x01);
    expect(Buffer.from(frame.slice(17, 25)).readBigUInt64BE()).toBe(7n);
  });

  it('encodes the id as 16 raw UUID bytes, not ASCII', () => {
    const frame = encodeDownloadChunk(ID, 0, new Uint8Array(0));
    // `toEqual` on a typed array narrows to the *class*: a `Uint8Array` slice
    // never equals a `Buffer` even with identical bytes. Compare bytes.
    expect(Array.from(frame.slice(1, 17))).toEqual(
      Array.from(Buffer.from('0f8fad5bd9cb469fa16570867728950e', 'hex')),
    );
  });

  it('decodes an upload frame as type 0x02', () => {
    const frame = encodeDownloadChunk(ID, 3, new Uint8Array([9]));
    frame[0] = 0x02;
    const decoded = decodeUploadChunk(frame);
    expect(decoded.transferId).toBe(ID);
    expect(decoded.chunkIndex).toBe(3);
    expect(decoded.payload).toEqual(new Uint8Array([9]));
  });

  it('rejects a truncated header', () => {
    expect(() => decodeUploadChunk(new Uint8Array(24))).toThrow(SandboxError);
  });

  it('rejects a payload above the chunk cap', () => {
    expect(() => decodeUploadChunk(new Uint8Array(25 + 32769))).toThrow(
      /exceeds/,
    );
  });

  it('accepts a payload of exactly the cap', () => {
    expect(() => decodeUploadChunk(new Uint8Array(25 + 32768))).not.toThrow();
  });
});

describe('partName', () => {
  it('appends the resume suffix as a sibling', () => {
    expect(partName('report.pdf')).toBe('report.pdf.ponter-part');
  });
});

describe('frameFiles — the outbound envelope (R1)', () => {
  it('wraps a JSON frame as { type, channel, payload, timestamp }', () => {
    const frame = { type: 'files-list-result', requestId: 'r-1', entries: [] };
    expect(frameFiles(frame, 1_700_000_000_000)).toEqual({
      type: 'files-list-result',
      channel: 'files',
      payload: { type: 'files-list-result', requestId: 'r-1', entries: [] },
      timestamp: 1_700_000_000_000,
    });
  });

  it('nests the fields instead of leaving them as siblings', () => {
    // The defect this pins: the plan's frames were flat, the browser reads
    // `msg.payload`, and `packages/webrtc-core/src/data-channel.ts:33-38`
    // swallows the resulting `TypeError` in a bare `catch {}`. So a flat frame
    // is not a wrong answer — it is a promise that never settles.
    const framed = frameFiles(
      { type: 'files-error', code: 'BAD_FRAME' },
      0,
    ) as unknown as Record<string, unknown>;
    expect(framed).not.toHaveProperty('code'); // the field moved into `payload`
    expect(framed.payload).toMatchObject({ code: 'BAD_FRAME' });
  });

  it('pins channel to "files" for every frame', () => {
    expect(
      frameFiles({ type: 'files-error', code: 'BAD_FRAME' }, 0).channel,
    ).toBe('files');
  });
});

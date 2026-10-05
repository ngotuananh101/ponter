import { describe, it, expect, beforeEach } from 'vitest';
import {
  BINARY_TYPE_DOWNLOAD_CHUNK,
  BINARY_TYPE_UPLOAD_CHUNK,
} from '@ponter/shared';
import { FileClient } from '../src/client';
import { packBinaryChunk } from '../src/binary';
import { FilesError } from '../src/errors';
import { makeFakeManager } from './helpers';

describe('FileClient (spec §5.2)', () => {
  let fake: ReturnType<typeof makeFakeManager>;
  let client: FileClient;

  beforeEach(() => {
    fake = makeFakeManager();
    client = new FileClient('ag-1', fake.manager);
  });

  it('list resolves with the matching files-list-result and strips requestId', async () => {
    const promise = client.list('docs');
    const requestId = fake.sent.at(-1)?.payload.requestId as string;
    expect(fake.sent.at(-1)).toMatchObject({
      label: 'files',
      type: 'files-list',
    });

    fake.emit('files-list-result', {
      requestId,
      path: 'docs',
      entries: [
        {
          name: 'a.txt',
          path: 'docs/a.txt',
          size: 3,
          isDirectory: false,
          modifiedAt: '2026-10-04T00:00:00Z',
        },
      ],
      truncated: false,
    });

    const result = await promise;
    expect(result.path).toBe('docs');
    expect(result.entries).toHaveLength(1);
    expect(result).not.toHaveProperty('requestId');
  });

  it('list rejects with the wire code on a matching files-error', async () => {
    const promise = client.list('nope');
    const requestId = fake.sent.at(-1)?.payload.requestId as string;
    fake.emit('files-error', {
      requestId,
      code: 'NOT_FOUND',
      message: 'no such dir',
    });

    await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('download assembles chunks, acks cumulatively and resolves on files-download-end', async () => {
    const progress: number[] = [];
    const handle = client.download('a.bin', (p) =>
      progress.push(p.bytesTransferred),
    );
    const transferId = fake.sent.at(-1)?.payload.transferId as string;
    expect(handle.transferId).toBe(transferId);

    fake.emit('files-download-begin', {
      transferId,
      name: 'a.bin',
      path: 'a.bin',
      size: 32769,
      totalChunks: 2,
    });
    const first = new Uint8Array(32768).fill(7);
    // ADR-36 (GAP-B): download chunks arrive as binary frames via the raw
    // seam — NO base64.
    fake.emitRaw(
      packBinaryChunk(BINARY_TYPE_DOWNLOAD_CHUNK, transferId, 0, first),
    );
    fake.emitRaw(
      packBinaryChunk(
        BINARY_TYPE_DOWNLOAD_CHUNK,
        transferId,
        1,
        new Uint8Array([9]),
      ),
    );
    fake.emit('files-download-end', { transferId });

    const bytes = (await handle.done) as Uint8Array;
    expect(bytes).toHaveLength(32769);
    expect(bytes[0]).toBe(7);
    expect(bytes[32768]).toBe(9);

    const acks = fake.sent.filter((f) => f.type === 'files-download-ack');
    expect(acks.map((a) => a.payload.nextChunkIndex)).toEqual([1, 2]);
    expect(progress).toEqual([32768, 32769]);
  });

  it('download rejects the handle on a files-error for its id', async () => {
    const handle = client.download('a.bin');
    const transferId = fake.sent.at(-1)?.payload.transferId as string;
    fake.emit('files-error', {
      transferId,
      code: 'NOT_FOUND',
      message: 'gone',
    });

    await expect(handle.done).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('upload pumps chunks under the window and resumes on acks', async () => {
    // 70 chunks: with a 64-chunk window, the first pump fills 64; an ack of
    // 64 opens the window again so chunk 64 arrives, then a final ack of 70
    // triggers files-upload-end.
    const chunks = 70;
    const bytes = new Uint8Array(chunks * 32768);
    bytes[0] = 1;
    bytes[bytes.length - 1] = 2;
    const handle = client.upload('dir', 'big.bin', bytes, () => {});
    const transferId = fake.sent.at(-1)?.payload.transferId as string;

    fake.emit('files-upload-ack', { transferId, nextChunkIndex: 0 });
    let rawChunks = fake.rawSent.filter(
      (r) => r.bytes[0] === BINARY_TYPE_UPLOAD_CHUNK,
    );
    expect(rawChunks).toHaveLength(64); // window filled

    fake.emit('files-upload-ack', { transferId, nextChunkIndex: 64 });
    rawChunks = fake.rawSent.filter(
      (r) => r.bytes[0] === BINARY_TYPE_UPLOAD_CHUNK,
    );
    expect(rawChunks).toHaveLength(70); // resumed
    expect(fake.sent.filter((f) => f.type === 'files-upload-end')).toHaveLength(
      1,
    );

    fake.emit('files-upload-complete', {
      transferId,
      name: 'big.bin',
      path: 'dir/big.bin',
      size: bytes.length,
    });
    await expect(handle.done).resolves.toBeUndefined();
  });

  it('upload rejects when the agent refuses at begin', async () => {
    const handle = client.upload('', 'x', new Uint8Array(1));
    const transferId = fake.sent.at(-1)?.payload.transferId as string;
    fake.emit('files-error', {
      transferId,
      code: 'FILE_EXISTS',
      message: 'exists',
    });

    await expect(handle.done).rejects.toMatchObject({ code: 'FILE_EXISTS' });
  });

  it('cancel() sends files-cancel and rejects with CANCELLED', async () => {
    const handle = client.download('a.bin');
    handle.cancel();
    handle.cancel();

    expect(fake.sent.filter((f) => f.type === 'files-cancel')).toHaveLength(1);
    await expect(handle.done).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('ignores frames for an unknown transferId and surfaces unsolicited errors via onError', async () => {
    const errors: Array<{ code: string; message: string }> = [];
    const off = client.onError((code, message) =>
      errors.push({ code, message }),
    );

    // ADR-36 (GAP-B): download chunks arrive as binary frames on the raw
    // seam; an unknown transferId is silently ignored.
    fake.emitRaw(
      packBinaryChunk(
        BINARY_TYPE_DOWNLOAD_CHUNK,
        '00000000-0000-0000-0000-000000000000',
        0,
        new Uint8Array(4),
      ),
    );
    fake.emit('files-error', { code: 'TRANSFER_TIMEOUT', message: 'idle' });

    expect(errors).toEqual([{ code: 'TRANSFER_TIMEOUT', message: 'idle' }]);
    off();
  });

  it('dispose() rejects in-flight handles with CANCELLED and unsubscribes', async () => {
    const handle = client.download('a.bin');
    client.dispose();

    await expect(handle.done).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fake.off).toHaveBeenCalled();
    expect(fake.offRaw).toHaveBeenCalled();
    expect(() => client.list('')).toThrow(FilesError);
  });
});

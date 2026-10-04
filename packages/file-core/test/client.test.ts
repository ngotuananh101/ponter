import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DataChannelManager } from '@ponter/webrtc-core';
import { FileClient } from '../src/client';
import { FilesError } from '../src/errors';

interface FakeFrame {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * A fake DataChannelManager: captures `sendJson` calls and lets the test
 * replay agent frames through the registered `onMessage` handler.
 */
function makeFakeManager() {
  const sent: Array<FakeFrame & { label: string }> = [];
  let handler:
    | ((msg: {
        type: string;
        channel: string;
        payload: unknown;
        timestamp: number;
      }) => void)
    | null = null;
  const off = vi.fn();
  return {
    sent,
    off,
    manager: {
      sendJson: (
        label: string,
        type: string,
        payload: Record<string, unknown>,
      ) => {
        sent.push({ label, type, payload });
      },
      onMessage: (
        label: string,
        h: (msg: {
          type: string;
          channel: string;
          payload: unknown;
          timestamp: number;
        }) => void,
      ) => {
        expect(label).toBe('files');
        handler = h;
        return off;
      },
    } as unknown as DataChannelManager,
    emit: (type: string, payload: Record<string, unknown>) => {
      handler?.({ type, channel: 'files', payload, timestamp: Date.now() });
    },
  };
}

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
    fake.emit('files-download-chunk', {
      transferId,
      chunkIndex: 0,
      totalChunks: 2,
      data: Buffer.from(first).toString('base64'),
    });
    fake.emit('files-download-chunk', {
      transferId,
      chunkIndex: 1,
      totalChunks: 2,
      data: Buffer.from(new Uint8Array([9])).toString('base64'),
    });
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
    const bytes = new Uint8Array(17 * 32768);
    const handle = client.upload('dir', 'big.bin', bytes, () => {});
    const transferId = fake.sent.at(-1)?.payload.transferId as string;

    fake.emit('files-upload-ack', { transferId, nextChunkIndex: 0 });
    let chunks = fake.sent.filter((f) => f.type === 'files-upload-chunk');
    expect(chunks).toHaveLength(16); // window filled

    fake.emit('files-upload-ack', { transferId, nextChunkIndex: 16 });
    chunks = fake.sent.filter((f) => f.type === 'files-upload-chunk');
    expect(chunks).toHaveLength(17); // resumed
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

    fake.emit('files-download-chunk', {
      transferId: 'nope',
      chunkIndex: 0,
      totalChunks: 1,
      data: '',
    });
    fake.emit('files-error', { code: 'TRANSFER_TIMEOUT', message: 'idle' });

    expect(errors).toEqual([{ code: 'TRANSFER_TIMEOUT', message: 'idle' }]);
    off();
  });

  it('dispose() rejects in-flight handles with CANCELLED and unsubscribes', async () => {
    const handle = client.download('a.bin');
    client.dispose();

    await expect(handle.done).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fake.off).toHaveBeenCalled();
    expect(() => client.list('')).toThrow(FilesError);
  });
});

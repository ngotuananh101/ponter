import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DataChannelManager } from '@ponter/webrtc-core';
import { FileClient } from '../src/client';

interface FakeFrame {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * A fake DataChannelManager that captures both typed (`sendJson`) and binary
 * (`sendRaw`) calls, and can replay either kind through the registered handlers.
 * Mirrors `client.test.ts`'s `makeFakeManager`.
 */
function makeFakeManager() {
  const sent: Array<FakeFrame & { label: string }> = [];
  const rawSent: Array<{ label: string; bytes: Uint8Array }> = [];
  let handler:
    | ((msg: {
        type: string;
        channel: string;
        payload: unknown;
        timestamp: number;
      }) => void)
    | null = null;
  let rawHandler: ((data: string | ArrayBuffer) => void) | null = null;
  const off = vi.fn();
  const offRaw = vi.fn();
  return {
    sent,
    rawSent,
    off,
    offRaw,
    manager: {
      sendJson: (
        label: string,
        type: string,
        payload: Record<string, unknown>,
      ) => {
        sent.push({ label, type, payload });
      },
      sendRaw: (label: string, data: string | ArrayBuffer | Uint8Array) => {
        rawSent.push({
          label,
          bytes:
            data instanceof Uint8Array
              ? data
              : new Uint8Array(data as ArrayBuffer),
        });
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
      onRawMessage: (
        label: string,
        h: (data: string | ArrayBuffer) => void,
      ) => {
        expect(label).toBe('files');
        rawHandler = h;
        return offRaw;
      },
    } as unknown as DataChannelManager,
    emit: (type: string, payload: Record<string, unknown>) => {
      handler?.({ type, channel: 'files', payload, timestamp: Date.now() });
    },
    emitRaw: (bytes: Uint8Array | ArrayBuffer) => {
      const buf =
        bytes instanceof ArrayBuffer
          ? bytes
          : bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            );
      rawHandler?.(buf as ArrayBuffer);
    },
  };
}

describe('FileClient directory operations (spec §3.3)', () => {
  let fake: ReturnType<typeof makeFakeManager>;
  let client: FileClient;

  beforeEach(() => {
    fake = makeFakeManager();
    client = new FileClient('ag-1', fake.manager);
  });

  it('sends files-mkdir and resolves on files-action-result', async () => {
    const promise = client.mkdir('docs', 'new');
    const frame = fake.sent.at(-1);
    expect(frame).toMatchObject({
      label: 'files',
      type: 'files-mkdir',
      payload: { dir: 'docs', name: 'new' },
    });
    expect(frame?.payload).toHaveProperty('requestId');

    fake.emit('files-action-result', {
      requestId: frame?.payload.requestId,
      action: 'mkdir',
      success: true,
    });
    await expect(promise).resolves.toBeUndefined();
  });

  it('mkdir rejects with BAD_FRAME when the result carries an unknown error string', async () => {
    const promise = client.mkdir('docs', 'new');
    const frame = fake.sent.at(-1);
    fake.emit('files-action-result', {
      requestId: frame?.payload.requestId,
      action: 'mkdir',
      success: false,
      error: 'not-a-real-code',
    });
    await expect(promise).rejects.toMatchObject({ code: 'BAD_FRAME' });
  });

  it('mkdir rejects with the wire code when success is false', async () => {
    const promise = client.mkdir('docs', 'new');
    const frame = fake.sent.at(-1);
    fake.emit('files-action-result', {
      requestId: frame?.payload.requestId,
      action: 'mkdir',
      success: false,
      error: 'FILE_EXISTS',
    });
    await expect(promise).rejects.toMatchObject({ code: 'FILE_EXISTS' });
  });

  it('sends files-delete and resolves on files-action-result', async () => {
    const promise = client.delete('docs/x.txt', true);
    const frame = fake.sent.at(-1);
    expect(frame).toMatchObject({
      label: 'files',
      type: 'files-delete',
      payload: { path: 'docs/x.txt', recursive: true },
    });
    expect(frame?.payload).toHaveProperty('requestId');

    fake.emit('files-action-result', {
      requestId: frame?.payload.requestId,
      action: 'delete',
      success: true,
    });
    await expect(promise).resolves.toBeUndefined();
  });

  it('sends files-rename and resolves on files-action-result', async () => {
    const promise = client.rename('docs/old.txt', 'docs/new.txt');
    const frame = fake.sent.at(-1);
    expect(frame).toMatchObject({
      label: 'files',
      type: 'files-rename',
      payload: { oldPath: 'docs/old.txt', newPath: 'docs/new.txt' },
    });
    expect(frame?.payload).toHaveProperty('requestId');

    fake.emit('files-action-result', {
      requestId: frame?.payload.requestId,
      action: 'rename',
      success: true,
    });
    await expect(promise).resolves.toBeUndefined();
  });

  it('delete rejects with CANCELLED after dispose()', async () => {
    const promise = client.delete('docs/x.txt');
    client.dispose();
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('ignores files-action-result for an unknown requestId', async () => {
    const errors: Array<{ code: string; message: string }> = [];
    client.onError((code, message) => errors.push({ code, message }));
    const promise = client.mkdir('docs', 'new');
    const frame = fake.sent.at(-1);

    // A different requestId — the pending entry is never matched.
    fake.emit('files-action-result', {
      requestId: 'does-not-match',
      action: 'mkdir',
      success: true,
    });
    // original frame's requestId still pending
    fake.emit('files-action-result', {
      requestId: frame?.payload.requestId,
      action: 'mkdir',
      success: true,
    });
    await expect(promise).resolves.toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('surfaces a pending-list files-error by requestId', async () => {
    const promise = client.mkdir('docs', 'new');
    const frame = fake.sent.at(-1);
    fake.emit('files-error', {
      requestId: frame?.payload.requestId,
      code: 'NOT_FOUND',
      message: 'no parent',
    });
    await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('FileClient uploadStream (spec §2.5 / GAP-B)', () => {
  let fake: ReturnType<typeof makeFakeManager>;
  let client: FileClient;

  beforeEach(() => {
    fake = makeFakeManager();
    client = new FileClient('ag-1', fake.manager);
  });

  it('slices a File into binary frames and pumps under the window', async () => {
    // 3 chunks: fills the default window (64) on the first pump.
    const chunkBytes = 32768;
    const buf = new Uint8Array(3 * chunkBytes);
    buf[0] = 1;
    buf[3 * chunkBytes - 1] = 2;
    const file = new File([buf], 'big.bin', {
      type: 'application/octet-stream',
    });

    const handle = client.uploadStream('dir', file);
    const begin = fake.sent.find((f) => f.type === 'files-upload-begin');
    expect(begin).toMatchObject({
      type: 'files-upload-begin',
      payload: { path: 'dir', name: 'big.bin', size: 3 * chunkBytes },
    });

    const transferId = begin!.payload.transferId as string;

    // An ack of 0 lets the client pump; with window 64 and only 3 chunks,
    // all 3 raw upload frames should be emitted. The send path slices each
    // chunk from the File asynchronously (file.slice().arrayBuffer()) and
    // chains them so they go out in order, so we flush the microtask queue
    // enough times for each link in the chain to resolve before asserting on
    // rawSent.
    fake.emit('files-upload-ack', { transferId, nextChunkIndex: 0 });
    // Allow the async chain (slice→sendRaw per chunk) to resolve. Each chain
    // link awaits `file.slice().arrayBuffer()` (a macrotask in jsdom) before
    // sending the next chunk, so drain both microtasks and macrotasks to let
    // all 3 chunks settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(fake.rawSent).toHaveLength(3);
    const sizes = fake.rawSent.map((r) => r.bytes.byteLength);
    // 3 * 32768 = 98304, exactly divisible: all three chunks are full-size.
    expect(sizes[0]).toBe(25 + chunkBytes);
    expect(sizes[1]).toBe(25 + chunkBytes);
    expect(sizes[2]).toBe(25 + chunkBytes);

    fake.emit('files-upload-complete', {
      transferId,
      name: 'big.bin',
      path: 'dir/big.bin',
      size: 3 * chunkBytes,
    });
    await expect(handle.done).resolves.toBeUndefined();
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { DataChannelManager } from '@ponter/webrtc-core';
import { FileClient } from '../src/client';
import { ServiceWorkerStreamWriter } from '../src/sw-writer';

interface FakeFrame {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * A fake DataChannelManager: captures `sendJson` calls and lets the test
 * replay agent frames through the registered `onMessage` handler.
 * Also captures `sendRaw` and can replay binary frames via `emitRaw`.
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

/**
 * A minimal mock `MessagePort` pair. The `ServiceWorkerStreamWriter` holds
 * `near`; the test controls `far` (e.g. closes it mid-transfer). After
 * `far.close()` the near port's `postMessage` throws (as a real closed port
 * would), which makes `writer.writeChunk`/`end` reject and flip `isClosed`.
 */
function makeMockStreamWriter() {
  let closed = false;

  const near: MessagePort = {
    postMessage: () => {
      if (closed) {
        throw new DOMException('port closed', 'InvalidStateError');
      }
    },
    onmessage: null,
    onmessageerror: null,
    close: () => {
      closed = true;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    start: () => {},
    unsubscribe: () => {},
  } as unknown as MessagePort;

  const far: MessagePort = {
    postMessage: () => {
      if (closed) {
        throw new DOMException('port closed', 'InvalidStateError');
      }
    },
    onmessage: null,
    onmessageerror: null,
    close: () => {
      closed = true;
      // In a real MessageChannel, closing one port makes the other unable to
      // deliver messages; simulate by delegating to the near port's close.
      near.close();
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    start: () => {},
    unsubscribe: () => {},
  } as unknown as MessagePort;

  return {
    writer: new ServiceWorkerStreamWriter(near, {
      transferId: 'test',
      filename: 'test.bin',
      size: 3,
    }),
    farPort: far,
    nearPort: near,
  };
}

describe('FileClient Pause and Resume', () => {
  it('sends files-pause frame and settles on pause ack', async () => {
    const fake = makeFakeManager();
    const client = new FileClient('ag-1', fake.manager);

    // Start an upload so the transfer is tracked, then pause it.
    const handle = client.upload('docs', 'f.bin', new Uint8Array(64));
    const pausePromise = client.pauseTransfer(handle.transferId, 'upload');

    const frame = fake.sent.at(-1);
    expect(frame).toMatchObject({
      label: 'files',
      type: 'files-pause',
      payload: { transferId: handle.transferId, direction: 'upload' },
    });

    // Replay the ack; the promise settles.
    fake.emit('files-pause-ack', {
      transferId: handle.transferId,
      ackedChunkIndex: 0,
      bytesTransferred: 0,
    });
    await expect(pausePromise).resolves.toBeUndefined();
  });

  it('tears down cleanly when the stream port closes mid-transfer (Review Focus #4)', async () => {
    // ServiceWorkerStreamWriter over a mock MessagePort pair; close the far
    // port after the first chunk. The next writeChunk/end must reject (or the
    // writer must expose a settled/aborted state) and release its port —
    // no dangling channels, no unhandled rejection.
    const { writer, farPort } = makeMockStreamWriter();
    await writer.writeChunk(new Uint8Array([1, 2, 3]));
    farPort.close();
    await expect(writer.end()).rejects.toThrow();
    expect(writer.isClosed).toBe(true);
  });
});

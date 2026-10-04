import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_WINDOW_SIZE,
  FILE_CHUNK_BYTES,
  TransferState,
  expectedChunkBytes,
  totalChunksFor,
} from '../src/transfer';
import { FilesError } from '../src/errors';

/** The send seam the client provides; records every frame the machine emits. */
function makeSend() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    send: vi.fn((frame: Record<string, unknown>) => {
      sent.push(frame);
    }),
  };
}

describe('chunk arithmetic (spec §2.5)', () => {
  it('pins the constants', () => {
    expect(FILE_CHUNK_BYTES).toBe(32768);
    expect(DEFAULT_WINDOW_SIZE).toBe(16);
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(30_000);
  });

  it('computes totalChunks with ceil and 0 for an empty file', () => {
    expect(totalChunksFor(0)).toBe(0);
    expect(totalChunksFor(32768)).toBe(1);
    expect(totalChunksFor(32769)).toBe(2);
    expect(totalChunksFor(600 * 1024)).toBe(19);
  });

  it('computes the expected byte length of each chunk', () => {
    expect(expectedChunkBytes(2, 32769, 0)).toBe(32768);
    expect(expectedChunkBytes(2, 32769, 1)).toBe(1);
    expect(expectedChunkBytes(1, 32768, 0)).toBe(32768);
  });
});

describe('TransferState window + acks (spec §2.4)', () => {
  let clock: ReturnType<typeof vi.useFakeTimers> | null = null;

  beforeEach(() => {
    clock = vi.useFakeTimers();
  });

  afterEach(() => {
    clock?.useRealTimers();
  });

  it('sends while sent - acked < windowSize and stops at the window', () => {
    const { sent, send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'upload',
      totalChunks: 20,
      size: 20 * FILE_CHUNK_BYTES,
      windowSize: 16,
      idleTimeoutMs: 30_000,
      send,
    });

    state.pump();

    expect(sent).toHaveLength(16);
    expect(sent.at(0)).toMatchObject({ chunkIndex: 0 });
    expect(sent.at(-1)).toMatchObject({ chunkIndex: 15 });
  });

  it('advances on a cumulative ack and ignores duplicate/regressive acks', () => {
    const { sent, send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'upload',
      totalChunks: 20,
      size: 20 * FILE_CHUNK_BYTES,
      windowSize: 16,
      idleTimeoutMs: 30_000,
      send,
    });

    state.pump();
    state.onAck(4); // cumulative: chunks 0..3 are in
    expect(sent).toHaveLength(20);

    state.onAck(4); // duplicate: ignored
    state.onAck(2); // regressive: ignored
    expect(state.ackedCount).toBe(4);
    expect(sent).toHaveLength(20);
  });

  it('fails with BAD_FRAME on an ack beyond what was sent', () => {
    const { send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'upload',
      totalChunks: 4,
      size: 4 * FILE_CHUNK_BYTES,
      windowSize: 16,
      idleTimeoutMs: 30_000,
      send,
    });

    state.pump();
    // attach a consumer so the BAD_FRAME rejection doesn't float as unhandled
    state.settled.catch(() => {});
    expect(() => state.onAck(5)).not.toThrow();
    expect(state.failure).toBeInstanceOf(FilesError);
    expect(state.failure?.code).toBe('BAD_FRAME');
  });

  it('rejects the transfer with BAD_FRAME on a chunk gap', () => {
    const { send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'download',
      totalChunks: 3,
      size: 3 * FILE_CHUNK_BYTES,
      windowSize: 16,
      idleTimeoutMs: 30_000,
      send,
    });

    state.settled.catch(() => {});
    state.onChunkReceived(0, FILE_CHUNK_BYTES);
    state.onChunkReceived(2, FILE_CHUNK_BYTES); // gap: 1 never arrived
    expect(state.failure?.code).toBe('BAD_FRAME');
  });

  it('rejects a chunk whose decoded length disagrees with the declared size', () => {
    const { send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'download',
      totalChunks: 2,
      size: 32769,
      windowSize: 16,
      idleTimeoutMs: 30_000,
      send,
    });

    state.settled.catch(() => {});
    state.onChunkReceived(0, 32768);
    state.onChunkReceived(1, 5); // final chunk must be exactly 1 byte
    expect(state.failure?.code).toBe('BAD_FRAME');
  });

  it('fails with TRANSFER_TIMEOUT when no chunk or ack arrives within idleTimeoutMs', () => {
    const { send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'download',
      totalChunks: 2,
      size: 2 * FILE_CHUNK_BYTES,
      windowSize: 16,
      idleTimeoutMs: 1000,
      send,
    });

    state.settled.catch(() => {});
    state.armIdleTimer();
    vi.advanceTimersByTime(1001);

    expect(state.failure?.code).toBe('TRANSFER_TIMEOUT');
  });

  it('cancel() is idempotent and yields CANCELLED', () => {
    const { send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'upload',
      totalChunks: 4,
      size: 4 * FILE_CHUNK_BYTES,
      windowSize: 16,
      idleTimeoutMs: 30_000,
      send,
    });

    // attach a consumer so the cancel rejection doesn't float as unhandled
    state.settled.catch(() => {});

    state.cancel();
    state.cancel();

    expect(state.failure?.code).toBe('CANCELLED');
    expect(state.settled).toBeInstanceOf(Promise);
    expect(send).toHaveBeenCalledTimes(1); // one files-cancel frame, not two
  });

  it('pump() is a loud tripwire on a download state', () => {
    const { send } = makeSend();
    const state = new TransferState({
      transferId: 't-dl',
      direction: 'download',
      totalChunks: 2,
      size: 2 * FILE_CHUNK_BYTES,
      windowSize: 16,
      idleTimeoutMs: 30_000,
      send,
    });
    state.settled.catch(() => {});
    expect(() => state.pump()).toThrow(/upload-only/i);
  });
});

// apps/agent/src/files/protocol.ts
import type { DataChannelMessage } from '@ponter/shared';
import { SandboxError } from './sandbox.js';

export const FILE_CHUNK_BYTES = 32_768;
export const FILE_WINDOW_CHUNKS = 64;
export const FILES_IDLE_TIMEOUT_MS = 30_000;
export const ACK_FREQUENCY_CHUNKS = 16;
export const ACK_FLUSH_INTERVAL_MS = 20;
export const FILE_MAX_BYTES = 1024 ** 3;
export const MAX_LIST_ENTRIES = 4096;
export const PART_SUFFIX = '.ponter-part';

/**
 * A frame this session can emit: a JSON object, a raw text frame, or a binary
 * chunk. Declared **here** rather than in `session.ts` because `frameFiles`
 * below takes and returns it, and a type a module's own signature depends on
 * cannot live in a module that imports it.
 */
export type FilesFrame =
  string | Uint8Array | { type: string; [key: string]: unknown };

export const DOWNLOAD_CHUNK = 0x01;
export const UPLOAD_CHUNK = 0x02;

const BINARY_HEADER_LEN = 25;
const TRANSFER_ID_LEN = 16;

/** `[1B type][16B id][8B big-endian index][payload]` — 25 bytes of header. */
export function totalChunks(size: number): number {
  return Math.ceil(size / FILE_CHUNK_BYTES);
}

export function expectedChunkLen(size: number, index: number): number {
  const remaining = size - index * FILE_CHUNK_BYTES;
  return Math.min(FILE_CHUNK_BYTES, Math.max(0, remaining));
}

function transferIdTo16(transferId: string): Uint8Array {
  const hex = transferId.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(hex))
    return new Uint8Array(Buffer.from(hex, 'hex'));
  // Test-only affordance the Rust also had: a non-UUID id becomes its first 16
  // ASCII bytes, NUL-padded. Production ids are always UUIDs.
  const out = new Uint8Array(TRANSFER_ID_LEN);
  Buffer.from(transferId, 'utf8').copy(
    Buffer.from(out.buffer),
    0,
    0,
    TRANSFER_ID_LEN,
  );
  return out;
}

function transferIdFrom16(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function encodeDownloadChunk(
  transferId: string,
  chunkIndex: number,
  payload: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(BINARY_HEADER_LEN + payload.length);
  frame[0] = DOWNLOAD_CHUNK;
  frame.set(transferIdTo16(transferId), 1);
  frame.set(new Uint8Array(Buffer.alloc(8)), 17);
  Buffer.from(frame.buffer).writeBigUInt64BE(BigInt(chunkIndex), 17);
  frame.set(payload, BINARY_HEADER_LEN);
  return frame;
}

/**
 * The inbound binary frame (B42). The type byte is **not** validated here: the
 * Rust routed by first byte at the dispatcher and only `0x02` reaches this
 * decoder, so validating it twice would produce two different error paths for
 * the same hostile input.
 */
export function decodeUploadChunk(frame: Uint8Array): {
  transferId: string;
  chunkIndex: number;
  payload: Uint8Array;
} {
  if (frame.length < BINARY_HEADER_LEN) {
    throw new SandboxError('BAD_FRAME', 'binary frame header truncated');
  }
  if (frame.length > BINARY_HEADER_LEN + FILE_CHUNK_BYTES) {
    throw new SandboxError(
      'BAD_FRAME',
      'binary frame payload exceeds chunk cap',
    );
  }
  const view = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    transferId: transferIdFrom16(frame.slice(1, 17)),
    chunkIndex: Number(view.readBigUInt64BE(17)),
    payload: frame.slice(BINARY_HEADER_LEN),
  };
}

export function partName(name: string): string {
  return `${name}${PART_SUFFIX}`;
}

/**
 * **R1: the outbound envelope, and why the plan's flat frames were a silent
 * hang rather than a visible bug.**
 *
 * The Rust builds every JSON frame through `frame_files`
 * (`apps/agent/src/files.rs:660`, with `channel: FILES_CHANNEL` at `:678`):
 * `{ type, channel: 'files', payload, timestamp }`. The plan emitted **flat**
 * frames — `{ type, requestId, path, entries, truncated }` with the fields as
 * siblings of `type`. Measured over Task 11's span: `channel` → 0 occurrences,
 * `timestamp` → 0, and `frame_files|frameFiles` → 1 (the retire clause's own
 * prose).
 *
 * The failure this produces is worth stating exactly, because it is invisible
 * in dev: the browser reads `msg.payload` (`packages/file-core/src/client.ts`,
 * `handleMessage`), so on a flat frame `payload` is `undefined` and
 * `payload.requestId` throws a `TypeError` — which
 * `packages/webrtc-core/src/data-channel.ts:33-38` swallows in the bare
 * `catch {}` that opens **before** its typed-handler loop. The remaining
 * handlers for that message are skipped, and `list()` / `mkdir()` /
 * `delete()`'s promise **never settles**: no resolve, no reject, no
 * `FilesError`, no unhandled rejection. There is no error to find because
 * nothing throws where anyone can see it.
 *
 * So the envelope is required, and it must be `DataChannelMessage` from
 * `@ponter/shared` (`packages/shared/src/types/webrtc.ts:9-14`) rather than a
 * local shape, so a drift in the shared type is a `tsc` error here.
 *
 * **Binary frames are deliberately not wrapped.** The Rust's `frame_files` is
 * the JSON path; chunk frames go out through `encodeDownloadChunk` and the
 * browser's raw handler reads them as bytes. Wrapping them would put a
 * `Uint8Array` inside a JSON string.
 *
 * `timestamp` is a parameter rather than an internal `Date.now()` so the
 * builder stays pure and the tests can pin it — the same reason every other
 * clock in this task is injected.
 */
export function frameFiles(
  payload: FilesFrame,
  timestamp: number,
): DataChannelMessage<FilesFrame> {
  return {
    type:
      typeof payload === 'object' && !(payload instanceof Uint8Array)
        ? payload.type
        : 'files-binary',
    channel: 'files',
    payload,
    timestamp,
  };
}

/**
 * `RemoteFile.modifiedAt` is an RFC 3339 UTC string (`files.rs:141-161`), not an
 * epoch number, and the value is always normalized to end in `Z` — the wire
 * type in `packages/shared/src/types/files.ts:6-13` declares `modifiedAt:
 * string`, and `apps/web`'s `formatModified` parses it as one.
 *
 * Seconds, not milliseconds: `mtimeMs` truncated. A directory's `mtimeMs` can
 * carry a fractional part that would otherwise leak into the string.
 */
export function rfc3339Utc(epochMs: number): string {
  const d = new Date(Math.floor(epochMs / 1000) * 1000);
  return `${d.toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
}

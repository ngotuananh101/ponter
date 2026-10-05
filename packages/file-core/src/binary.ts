import { BINARY_HEADER_LEN } from '@ponter/shared';
import { FILE_CHUNK_BYTES } from './transfer';

const MAX_BINARY_FRAME_LEN = BINARY_HEADER_LEN + FILE_CHUNK_BYTES;

/**
 * Encode a UUID string (dashed RFC 4122 form, e.g. `12345678-1234-4234-8234-123456789abc`)
 * into the 16 raw bytes that travel on the wire, stripping the four dash
 * separators. Matches ADR-36 (spec §5.1): the wire carries 16 bytes.
 */
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll('-', '');
  if (hex.length !== 32) {
    throw new Error('invalid uuid');
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Re-insert the RFC 4122 dashes into a 16-byte transfer id so callers receive
 * the same dashed string form `crypto.randomUUID()` produces.
 */
function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) {
    throw new Error('invalid transfer id length');
  }
  let hex = '';
  for (let i = 0; i < 16; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  // 8-4-4-4-12
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

/**
 * Pack an upload chunk into an ADR-36 binary frame:
 * `[1 byte type][16 byte transferId][8 byte BE chunkIndex][payload]`.
 *
 * The `transferId` is expected to be a dashed RFC 4122 UUID string; the dashes
 * are stripped and only the 16 hex-decoded bytes are written to the wire.
 */
export function packBinaryChunk(
  type: number,
  transferId: string,
  chunkIndex: number,
  data: Uint8Array,
): Uint8Array {
  const idBytes = uuidToBytes(transferId);
  const out = new Uint8Array(BINARY_HEADER_LEN + data.byteLength);
  out[0] = type;
  out.set(idBytes, 1);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setBigUint64(
    17,
    BigInt(chunkIndex),
    false,
  );
  out.set(data, BINARY_HEADER_LEN);
  return out;
}

/**
 * Unpack an ADR-36 binary chunk frame back into its component fields.
 *
 * - Length `< 25` (BINARY_HEADER_LEN) throws `/truncated/i`.
 * - Length `> 25 + FILE_CHUNK_BYTES` (32793) throws `/oversized/i`.
 *
 * The 16-byte wire transfer id is re-rendered as a dashed RFC 4122 UUID string.
 */
export function unpackBinaryChunk(bytes: Uint8Array): {
  type: number;
  transferId: string;
  chunkIndex: number;
  data: Uint8Array;
} {
  if (bytes.byteLength < BINARY_HEADER_LEN) {
    throw new Error('binary frame truncated');
  }
  if (bytes.byteLength > MAX_BINARY_FRAME_LEN) {
    throw new Error('binary frame oversized');
  }
  const type = bytes[0]!;
  const transferId = bytesToUuid(bytes.subarray(1, 17));
  const chunkIndex = Number(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
      17,
      false,
    ),
  );
  const data = bytes.subarray(BINARY_HEADER_LEN);
  return { type, transferId, chunkIndex, data };
}

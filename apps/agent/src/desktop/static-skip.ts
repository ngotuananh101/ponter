export interface RawFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
  seq: number;
}

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/**
 * A 64-bit FNV-1a hash over the pixel buffer and geometry — a faithful port of
 * the Rust's **single-accumulator** loop.
 *
 * The Rust's doc comment calls this "4-lane"; the code is one lane (there is a
 * single `hash` variable and no lane combining anywhere). The comment is
 * recorded as wrong rather than reproduced: writing a comment that claims four
 * lanes over a one-lane loop is exactly the kind of stale claim that made this
 * port necessary.
 *
 * Three details decide whether a port behaves the same:
 *
 * - **8-byte words, native endianness.** The Rust used `u64::from_ne_bytes`, so
 *   the machine's byte order is part of the hash. Node reads little-endian on
 *   every platform the agent ships on; matching that is what keeps skip
 *   behaviour identical, and a mismatch would only cost an extra encode.
 * - **The tail is folded one byte at a time**, not zero-padded into a word.
 * - **Geometry is XORed, not multiplied**: `(width << 32) | height`.
 *
 * `seq` is deliberately excluded: a repeated *pixel buffer* with a new sequence
 * number is still identical, and hashing the seq would defeat the whole skip.
 */
export function frameSignature(frame: RawFrame): bigint {
  let hash = FNV_OFFSET_BASIS;
  const bytes = frame.rgba;
  const words = Math.floor(bytes.length / 8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < words; i += 1) {
    hash ^= view.getBigUint64(i * 8, true);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  for (let i = words * 8; i < bytes.length; i += 1) {
    hash ^= BigInt(bytes[i]!);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  hash ^= (BigInt(frame.width) << 32n) | BigInt(frame.height);
  return hash & MASK64;
}

/**
 * The static-frame skip (B22).
 *
 * The keepalive is a **frame count** of `round(fps)`, not a wall-clock second.
 * The Rust's comment said "one second of frames" and the code said
 * `(fps.round()).max(1)`; the code is right and the comment described the common
 * case. Counting frames matters because the loop only ticks when the capture
 * source produces a frame — a stalled source would never reach a wall-clock
 * deadline either, and a counting cap forces an encode exactly `fps` skips after
 * the last real one.
 *
 * The forced-through frame becomes the new reference, because `last` is assigned
 * before the decision. That is what keeps a long static screen from alternating
 * between two hashes.
 */
export class StaticFrameSkip {
  private readonly maxConsecutiveSkips: number;
  private last: bigint | null = null;
  private consecutiveSkips = 0;

  constructor(fps: number) {
    this.maxConsecutiveSkips = Math.max(1, Math.round(fps));
  }

  shouldSkip(frame: RawFrame): boolean {
    const signature = frameSignature(frame);
    const identical = this.last === signature;
    this.last = signature;
    if (!identical) {
      this.consecutiveSkips = 0;
      return false;
    }
    if (this.consecutiveSkips >= this.maxConsecutiveSkips) {
      this.consecutiveSkips = 0;
      return false;
    }
    this.consecutiveSkips += 1;
    return true;
  }

  reset(): void {
    this.last = null;
    this.consecutiveSkips = 0;
  }
}

export function statsDueWhileSkipping(
  lastStatsAtMs: number,
  nowMs: number,
): boolean {
  return nowMs - lastStatsAtMs >= 1000;
}

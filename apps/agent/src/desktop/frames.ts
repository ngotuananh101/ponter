// apps/agent/src/desktop/frames.ts
import type { ProfileId } from '@ponter/shared';

export interface StatsInput {
  seq: number;
  fps: number;
  bitrate: number;
  encodeMsP50: number;
  captureMsP50: number;
  skippedFrames: number;
  profile: ProfileId;
}

export interface CursorInput {
  x: number;
  y: number;
  visible: boolean;
  shape: string | null;
  /**
   * ADR-47's echo: the `seq` of the last input frame the agent **applied**,
   * stamped on every `desktop-cursor` payload as `lastInputSeq` and read by the
   * browser's latency meter. The Rust carries it as `last_input_seq:
   * Option<u64>` with `skip_serializing_if = "Option::is_none"`
   * (`desktop.rs:2176-2177`), so the field is **omitted from the wire when
   * unset** — the builder below spreads it conditionally, never writing
   * `lastInputSeq: undefined` (which would survive `JSON.stringify` as an
   * absent key but would not survive a typed consumer that inspects
   * `Object.keys`). The **runtime owns the single mutable holder** for this
   * value — the Rust's hoisted `Arc<AtomicU64>`
   * (`lib.rs:2304-2312`, stored by the control task at `:2468`); the cursor
   * loop reads it, and Task 19's desktop session loop owns that wiring.
   */
  lastInputSeq?: number;
}

export interface SourcesInput {
  monitors: {
    id: string;
    name: string;
    width: number;
    height: number;
    primary: boolean;
  }[];
  windows: { id: string; title: string }[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function buildStatsFrame(input: StatsInput): string {
  return JSON.stringify({
    type: 'desktop-stats',
    data: {
      seq: input.seq,
      fps: round1(input.fps),
      bitrate: input.bitrate,
      encodeMsP50: round1(input.encodeMsP50),
      captureMsP50: round1(input.captureMsP50),
      skippedFrames: input.skippedFrames,
      profile: input.profile,
    },
  });
}

/**
 * `shape: null` when the cursor is hidden is deliberate rather than omitting the
 * key: the web cursor layer reads `data.shape` unconditionally and would draw
 * the previous shape at the new position.
 *
 * `lastInputSeq` is the inverse: it is **omitted when unset**, mirroring the
 * Rust's `skip_serializing_if = "Option::is_none"` (`desktop.rs:2176`) — the
 * browser treats an absent field and a `null` differently here (a stale echo
 * from an earlier input must not be re-sent forever; the holder resets to
 * null between applications). The conditional spread keeps the field off the
 * object rather than writing `undefined`.
 */
export function buildCursorFrame(input: CursorInput): string {
  return JSON.stringify({
    type: 'desktop-cursor',
    data: {
      x: input.x,
      y: input.y,
      visible: input.visible,
      shape: input.shape,
      ...(input.lastInputSeq === undefined
        ? {}
        : { lastInputSeq: input.lastInputSeq }),
    },
  });
}

export function buildSourcesFrame(input: SourcesInput): string {
  return JSON.stringify({
    type: 'desktop-sources',
    data: { monitors: input.monitors, windows: input.windows },
  });
}

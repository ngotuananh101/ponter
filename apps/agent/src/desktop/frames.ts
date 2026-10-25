// apps/agent/src/desktop/frames.ts
import type {
  DataChannelMessage,
  DesktopCursorPayload,
  DesktopSourceInfo,
  DesktopSourcesPayload,
  DesktopStats,
} from '@ponter/shared';

/**
 * TS-only divergence from Rust: the Rust serialises f32 p50s unrounded (7.25 -> 7.25);
 * the builder emits 7.3. Neither captureMsP50 nor encodeMsP50 has any reader in
 * packages/desktop-core/src or apps/web/src (where readers are targetBitrateBps, width,
 * height, status.kind, status.detail). The divergence is unobservable to readers
 * and kept to avoid moving green cells for measurement noise.
 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Stats frame builder. Mirrors Rust `frame_desktop_stats` (desktop.rs:2147).
 *
 * Optional fields (`status`, `frameSeq`, `captureMsP50`, `encodeMsP50`, `frameSamples`)
 * are omitted when unset via conditional spread, matching Rust's `skip_serializing_if`.
 */
export function buildStatsFrame(
  stats: DesktopStats,
  timestamp: number,
): string {
  const payload: DesktopStats = {
    width: stats.width,
    height: stats.height,
    fps: stats.fps,
    targetBitrateBps: stats.targetBitrateBps,
    ...(stats.status !== undefined ? { status: stats.status } : {}),
    ...(stats.frameSeq !== undefined ? { frameSeq: stats.frameSeq } : {}),
    ...(stats.captureMsP50 !== undefined
      ? { captureMsP50: round1(stats.captureMsP50) }
      : {}),
    ...(stats.encodeMsP50 !== undefined
      ? { encodeMsP50: round1(stats.encodeMsP50) }
      : {}),
    ...(stats.frameSamples !== undefined
      ? { frameSamples: stats.frameSamples }
      : {}),
  };
  return JSON.stringify({
    type: 'desktop-stats',
    channel: 'control',
    payload,
    timestamp,
  } satisfies DataChannelMessage<DesktopStats>);
}

/**
 * Cursor frame builder. Mirrors Rust `frame_desktop_cursor` (desktop.rs:2093).
 *
 * `shape` and `lastInputSeq` carry `skip_serializing_if = "Option::is_none"`
 * in Rust (desktop.rs:2175-2179), so both fields are omitted from the wire
 * when unset — the builder below uses conditional spread, never writing
 * `undefined` or `null`.
 */
export function buildCursorFrame(
  cursor: DesktopCursorPayload,
  timestamp: number,
): string {
  const payload: DesktopCursorPayload = {
    x: cursor.x,
    y: cursor.y,
    visible: cursor.visible,
    seq: cursor.seq,
    ...(cursor.lastInputSeq !== undefined
      ? { lastInputSeq: cursor.lastInputSeq }
      : {}),
    ...(cursor.shape !== undefined ? { shape: cursor.shape } : {}),
  };
  return JSON.stringify({
    type: 'desktop-cursor',
    channel: 'control',
    payload,
    timestamp,
  } satisfies DataChannelMessage<DesktopCursorPayload>);
}

/**
 * Desktop sources frame builder. Mirrors Rust `frame_desktop_sources` (desktop.rs:2066).
 *
 * Takes `inputEnabled`, `peerVerified`, and `cursorInFrame` flags as parameters and
 * renders each in both directions so that the wire format accurately reflects the
 * admission and capture state.
 */
export function buildSourcesFrame(
  sources: DesktopSourceInfo[],
  inputEnabled: boolean,
  peerVerified: boolean,
  cursorInFrame: boolean,
  timestamp: number,
): string {
  const payload: DesktopSourcesPayload = {
    sources,
    inputEnabled,
    peerVerified,
    cursorInFrame,
  };
  return JSON.stringify({
    type: 'desktop-sources',
    channel: 'control',
    payload,
    timestamp,
  } satisfies DataChannelMessage<DesktopSourcesPayload>);
}

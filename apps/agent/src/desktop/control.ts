// apps/agent/src/desktop/control.ts
import type { ProfileId } from '@ponter/shared';

export const MIN_BITRATE = 250_000;
export const MAX_BITRATE = 20_000_000;

const PROFILES = new Set<ProfileId>(['1080p60', '1080p30', '720p60', '720p30']);

export type StreamControl =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop' }
  | { kind: 'bitrate'; bitrate: number }
  | { kind: 'quality'; profile: ProfileId };

export type DesktopSource =
  | { kind: 'monitor'; id: string }
  | { kind: 'window'; id: string }
  | { kind: 'test' };

export function clampBitrate(bps: number): number {
  return Math.round(Math.min(Math.max(bps, MIN_BITRATE), MAX_BITRATE));
}

function parse(
  bytes: ArrayBuffer | Uint8Array,
): Record<string, unknown> | null {
  try {
    const text =
      bytes instanceof Uint8Array
        ? new TextDecoder().decode(bytes)
        : new TextDecoder().decode(new Uint8Array(bytes));
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * `StreamControl` decode (B20/B62).
 *
 * The bitrate clamp lives **in the decoder**, not at the call site. There are
 * three places a bitrate arrives: the initial apply, a live retarget, and the
 * post-resume re-apply. A clamp at any one of them is a clamp at none, and the
 * encoder's own limits are what turn an out-of-range value into a hard failure.
 */
export function decodeStreamControl(
  bytes: ArrayBuffer | Uint8Array,
): StreamControl | null {
  const message = parse(bytes);
  if (!message || message.type !== 'stream-control') return null;
  switch (message.action) {
    case 'pause':
      return { kind: 'pause' };
    case 'resume':
      return { kind: 'resume' };
    case 'stop':
      return { kind: 'stop' };
    case 'set-bitrate':
      if (
        typeof message.bitrate !== 'number' ||
        !Number.isFinite(message.bitrate)
      )
        return null;
      return { kind: 'bitrate', bitrate: clampBitrate(message.bitrate) };
    case 'set-quality':
      if (
        typeof message.profile !== 'string' ||
        !PROFILES.has(message.profile as ProfileId)
      )
        return null;
      return { kind: 'quality', profile: message.profile as ProfileId };
    default:
      return null;
  }
}

export function decodeDesktopSelect(
  bytes: ArrayBuffer | Uint8Array,
): DesktopSource | null {
  const message = parse(bytes);
  if (!message || message.type !== 'desktop-select') return null;
  const source = message.source;
  if (typeof source !== 'object' || source === null) return null;
  const value = source as Record<string, unknown>;
  if (value.kind === 'test') return { kind: 'test' };
  if (value.kind !== 'monitor' && value.kind !== 'window') return null;
  if (typeof value.id !== 'string' || value.id === '') return null;
  return { kind: value.kind, id: value.id };
}

/** Two seconds of frames, rounded, floored at 1. */
export function gopForFps(fps: number): number {
  return Math.max(1, Math.round(fps * 2));
}

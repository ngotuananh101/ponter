/**
 * The four desktop streaming presets, as a single source of truth.
 *
 * These values were the Rust agent's `StreamProfile` constants
 * (`apps/agent/src/lib.rs:445-490`). They live here so the web client, the
 * desktop shell and the agent all read one table instead of each carrying its
 * own copy — the arrangement that let the Rust agent advertise a
 * `profile-level-id` no preset could produce.
 */
export interface StreamProfile {
  /** The preset's stable id, as used in configuration and on the wire. */
  readonly id: string;
  /** The label shown in the UI. */
  readonly label: string;
  /** The maximum width, in pixels. */
  readonly maxWidth: number;
  /** The maximum height, in pixels. */
  readonly maxHeight: number;
  /** The target frame rate. */
  readonly fps: number;
  /** The target bitrate, in bits per second. */
  readonly bitrateBps: number;
  /** The H.264 profile-level-id the encoder is expected to produce. */
  readonly profileLevelId: string;
}

/**
 * The four shipped presets, in ascending order of cost.
 *
 * `profileLevelId` is not a constant: openh264 derives the level from the frame
 * size, the frame rate and the bitrate (`WelsGetLevelIdc`), so each preset gets
 * the level the encoder actually writes into its SPS. All four carry the
 * `42c0` prefix — baseline profile 66 with constraint byte `0xC0` — because
 * that is the SPS the encoder emits.
 */
export const STREAM_PROFILES: readonly StreamProfile[] = [
  {
    id: '1080p30',
    label: '1080p · 30 fps',
    maxWidth: 1920,
    maxHeight: 1080,
    fps: 30,
    bitrateBps: 6_000_000,
    profileLevelId: '42c028', // level 4.0
  },
  {
    id: '720p30',
    label: '720p · 30 fps',
    maxWidth: 1280,
    maxHeight: 720,
    fps: 30,
    bitrateBps: 4_000_000,
    profileLevelId: '42c01f', // level 3.1
  },
  {
    id: '1080p60',
    label: '1080p · 60 fps',
    maxWidth: 1920,
    maxHeight: 1080,
    fps: 60,
    bitrateBps: 8_000_000,
    profileLevelId: '42c02a', // level 4.2
  },
  {
    id: '720p60',
    label: '720p · 60 fps',
    maxWidth: 1280,
    maxHeight: 720,
    fps: 60,
    bitrateBps: 5_000_000,
    profileLevelId: '42c020', // level 3.2
  },
];

/** Look a preset up by its id. Throws when the id is unknown. */
export function streamProfileById(id: string): StreamProfile {
  const profile = STREAM_PROFILES.find((candidate) => candidate.id === id);
  if (profile === undefined) {
    throw new Error(
      `Unknown stream profile "${id}" — expected one of ${STREAM_PROFILES.map((p) => p.id).join(', ')}`,
    );
  }
  return profile;
}

// apps/agent/src/desktop/sustain.ts
import type { ProfileId } from '@ponter/shared';

export const SUSTAIN_FRAMES = 30;

/**
 * The downgrade path. `1080p30 -> 720p30` skips `720p60` deliberately: a source
 * already running at 30 fps cannot gain anything from a 60 fps target, so the
 * only useful move is down in resolution.
 */
export const SUSTAIN_LADDER: Record<ProfileId, ProfileId | null> = {
  '1080p60': '720p60',
  '720p60': '720p30',
  '1080p30': '720p30',
  '720p30': null,
};

/**
 * Quality degradation under sustained load (B18/B23).
 *
 * The input is the **single frame's** `encode_time`, not the p50 from the
 * timing ring. That is not an oversight in the Rust and it is not one here: the
 * ladder exists to catch a stall the moment it happens, and a median over 32
 * frames would not move until 17 frames had already been late.
 *
 * The budget comparison is **strictly greater**, and any on-budget frame resets
 * the run to zero. Both are load-bearing: a `>=` downgrades a stream that is
 * exactly meeting its target, and a non-resetting counter would let 15 bad
 * frames either side of a good one still trigger.
 */
export class SustainLadder {
  private profile: ProfileId;
  private consecutiveOver = 0;

  constructor(
    profile: ProfileId,
    private readonly budgetMs: number,
  ) {
    this.profile = profile;
  }

  noteFrame(encodeMs: number): ProfileId | null {
    if (encodeMs <= this.budgetMs) {
      this.consecutiveOver = 0;
      return null;
    }
    this.consecutiveOver += 1;
    if (this.consecutiveOver < SUSTAIN_FRAMES) return null;
    this.consecutiveOver = 0;
    const next = SUSTAIN_LADDER[this.profile];
    if (next === null) return null;
    this.profile = next;
    return next;
  }

  /**
   * A bitrate retarget re-opens the latch, unless the ladder is already at the
   * floor. It changes neither `budgetMs` nor the next rung.
   */
  noteBitrateChange(_bitrate: number): void {
    if (SUSTAIN_LADDER[this.profile] === null) return;
    this.consecutiveOver = 0;
  }

  current(): ProfileId {
    return this.profile;
  }

  consecutive(): number {
    return this.consecutiveOver;
  }
}

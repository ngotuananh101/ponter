import type { TerminalE2eeAck, TerminalE2eeHello } from '@ponter/shared';
import type {
  MediaStreamLike,
  MediaStreamTrackLike,
} from '@ponter/webrtc-core';

/** The first remote video track and whatever streams it belongs to. */
export interface DesktopStream {
  track: MediaStreamTrackLike;
  /** Possibly empty: werift's onTrack path carries no streams array. */
  streams: MediaStreamLike[];
}

export interface DesktopClientOptions {
  /** How long `start()` waits for the first remote track. Default 20_000. */
  trackTimeoutMs?: number;
  /** How long to wait for the control channel to open after the track. Default 5_000. */
  controlTimeoutMs?: number;
  /** Max `pointer-move` frames per second the client will forward. Default 60. */
  inputRateLimitHz?: number;
  /**
   * Target playout delay in milliseconds for the first remote video track.
   * Applied to the receiver's `jitterBufferTarget` (Chrome) or
   * `playoutDelayHint` (Firefox) after the track resolves. `null` disables
   * tuning (the receiver is left untouched). Default: 100.
   */
  playoutDelayMs?: number | null;
}

/**
 * The subset of the WS1 E2EE negotiation driver that the desktop client needs.
 * `TerminalE2ee` (terminal-core) structurally satisfies this — the store passes
 * the same instance. T6-B: desktop-core does NOT import @ponter/terminal-core.
 */
export interface DesktopE2eeDriver {
  isActive(): boolean;
  buildHello(terminalId: string): Promise<TerminalE2eeHello>;
  handleAck(ack: TerminalE2eeAck): Promise<void>;
  encrypt(data: Uint8Array): Promise<Uint8Array>;
  decrypt(data: Uint8Array): Promise<Uint8Array>;
}

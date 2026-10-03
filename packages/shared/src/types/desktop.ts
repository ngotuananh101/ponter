/**
 * Desktop control-channel wire types (Week 8, spec §2.2/§5.1).
 *
 * These are payload shapes only. The envelope is the existing
 * `DataChannelMessage<T>` (`types/webrtc.ts`): `{ type, channel: 'control',
 * payload: T, timestamp }`. The four frame types are `desktop-sources`,
 * `desktop-select`, `desktop-bitrate`, `desktop-stats`.
 */

/** One capture source the agent can stream (a monitor or a window). */
export interface DesktopSourceInfo {
  /** Stable per enumeration: `monitor:<id>` / `window:<id>`. */
  id: string;
  kind: 'monitor' | 'window';
  /** `Monitor::name()`/`friendly_name()` or `Window::title()`. */
  name: string;
  width: number;
  height: number;
  /** Source geometry — needed by Week 9 input mapping. */
  x: number;
  y: number;
  scaleFactor: number;
  rotation: number;
  isPrimary: boolean;
  /** The entry the agent is streaming right now. */
  default: boolean;
}

/** Best-effort telemetry the agent pushes for the UI (spec §2.2). */
export interface DesktopStats {
  width: number;
  height: number;
  fps: number;
  targetBitrateBps: number;
  /** Optional agent→browser note; absent on ordinary telemetry. */
  status?: { kind: 'select-refused' | 'quality-downgraded'; detail: string };
}

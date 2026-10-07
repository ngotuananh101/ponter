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

/**
 * Keyboard modifier state at the moment a `key` frame is emitted (spec §2.2).
 * Physical codes + modifier state make the mapping layout-independent.
 */
export interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * One forwarded input event (Week 9, spec §2.2). The `kind` tag selects the
 * fields. Pointer coordinates are normalized `0..1` within the *streamed
 * source* (the browser removes the `object-contain` letterbox first, ADR-30);
 * `code` is the physical `KeyboardEvent.code`; `text` is committed unicode.
 */
export type DesktopInput =
  | { kind: 'pointer-move'; x: number; y: number }
  | {
      kind: 'pointer-button';
      button: 'left' | 'middle' | 'right';
      pressed: boolean;
      x: number;
      y: number;
    }
  | { kind: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { kind: 'key'; code: string; pressed: boolean; modifiers: KeyModifiers }
  | { kind: 'text'; text: string };

/**
 * The `desktop-sources` payload (Week 8 + the Week 9 additive `inputEnabled`
 * + the Phase 6a additive `peerVerified`). A pre-6a client that ignores the
 * extra field is unaffected (spec §2.2, Phase 6a ADR-42).
 */
export interface DesktopSourcesPayload {
  sources: DesktopSourceInfo[];
  /** True iff the agent's input gate is open (ADR-29). */
  inputEnabled: boolean;
  /**
   * True iff the agent verified this session's peer identity at admission
   * (Phase 6a ADR-41/42). The agent sends a structural literal `true`; a
   * pre-6a agent omits the field and the client normalizes to `false`.
   */
  peerVerified: boolean;
}

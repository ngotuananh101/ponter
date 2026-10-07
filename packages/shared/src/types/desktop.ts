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
  /** Monotonic frame sequence from the agent's capture pipeline (ADR-45/ADR-47). */
  frameSeq?: number;
  /** Rolling latency p50 for capture stage, in milliseconds. */
  captureMsP50?: number;
  /** Rolling latency p50 for encode stage, in milliseconds. */
  encodeMsP50?: number;
  /** Rolling sample ring of per-frame timing: { seq, captureEpochMs, encodeMs }. */
  frameSamples?: Array<{
    seq: number;
    captureEpochMs: number;
    encodeMs: number;
  }>;
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
  | { kind: 'pointer-move'; x: number; y: number; seq?: number }
  | {
      kind: 'pointer-button';
      button: 'left' | 'middle' | 'right';
      pressed: boolean;
      x: number;
      y: number;
      seq?: number;
    }
  | {
      kind: 'wheel';
      dx: number;
      dy: number;
      x: number;
      y: number;
      seq?: number;
    }
  | { kind: 'key'; code: string; pressed: boolean; modifiers: KeyModifiers }
  | { kind: 'text'; text: string };

/**
 * A cursor shape update from the agent (ADR-45). `png` is a base64-encoded
 * PNG; the agent omits the field when the PNG exceeds 32 KiB (so `png` is
 * effectively always present when `shape` is present). `serial` is the agent's
 * monotonically increasing cursor serial (u32) used to reject stale frames.
 */
export interface DesktopShape {
  png: string;
  hotspotX: number;
  hotspotY: number;
  serial: number;
}

/**
 * Cursor position + shape frame emitted by the agent's capture pipeline
 * (ADR-45/ADR-47). `x`/`y` are normalized 0..1 within the streamed source.
 * `seq` is the agent's capture sequence (u64); `lastInputSeq` echoes the most
 * recently acked input so the client can measure one-way latency. `shape` is
 * present only when the cursor bitmap or hotspot changed.
 */
export interface DesktopCursorPayload {
  x: number;
  y: number;
  visible: boolean;
  seq: number;
  lastInputSeq?: number;
  shape?: DesktopShape;
}

/**
 * The `desktop-sources` payload (Week 8 + the Week 9 additive `inputEnabled`
 * + the Phase 6a additive `peerVerified` + the Phase 6b additive `cursorInFrame`).
 * A pre-6b client that ignores `cursorInFrame` is unaffected.
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
  /**
   * True iff the agent is currently emitting cursor-within-frame updates
   * (Phase 6b ADR-45). Absent means the cursor stream is not active; a client
   * that ignores this field simply never receives cursor frames.
   */
  cursorInFrame?: boolean;
}

// apps/agent/src/terminal/frames.ts
import type {
  DataChannelMessage,
  TerminalDataMessage,
  TerminalErrorMessage,
  TerminalExitMessage,
} from '@ponter/shared';
import type { PtyErrorCode } from './pty.js';

/**
 * The terminal wire contract (B41) — the three frames the agent **sends**.
 *
 * The JSON shape is the nested `DataChannelMessage` envelope the Rust builds in
 * `pty::DataChannelMessage` (`pty.rs:38-45`) and serde writes for all three
 * builders: `{type, channel: 'terminal', payload, timestamp}`. `type` is a
 * **sibling** of `payload`, never a member of it, and `channel` is the field
 * whose absence made every Task 17 desktop frame a silent drop.
 *
 * Every builder takes its `timestamp` as a parameter, exactly as the Rust does
 * (`pty.rs:141`, `:295`, `:80`). A builder that read `Date.now()` could not be
 * pinned, and two identical calls would disagree — which is the whole reason
 * the Rust passes the clock in.
 *
 * **These builders own the wire; `PtyManager` does not.** The manager is a
 * process manager: it reports `{terminalId, data}` and `{terminalId, exitCode}`
 * through callbacks and never serialises. Frames are built where a channel
 * knows what it carries (`AgentRuntime`'s terminal subscription), so no
 * `pty.test.ts` cell starts asserting an envelope its subject does not own.
 */

/**
 * The exit payload as Rust serialises it.
 *
 * `@ponter/shared` declares `TerminalExitMessage.exitCode?: number`
 * (`types/terminal.ts:38-41`), which cannot express the Rust's `None`. Rust's
 * `TerminalExitMessage.exit_code` is `Option<u32>` with **no**
 * `skip_serializing_if` (`pty.rs:270-274`), so serde writes
 * `"exitCode": null` — the key is always present, unlike Task 25's
 * `DesktopStats`, whose five optional fields carry the attribute
 * (`desktop.rs:2111-2119`). Widening locally rather than editing the shared
 * type keeps the browser package's contract untouched (it reads
 * `payload.exitCode` and `markExited(exitCode?: number)` treats `null` the same
 * as `undefined`, `terminal-core/src/session.ts:49-55`).
 */
export type TerminalExitPayload = Omit<TerminalExitMessage, 'exitCode'> & {
  exitCode: number | null;
};

/**
 * A `terminal-data` frame. Mirrors Rust `build_terminal_data_frame`
 * (`pty.rs:126-142`), the single spelling both the plaintext and the encrypted
 * path share.
 *
 * **`data` is already base64 and is passed through untouched.** The encode moved
 * to `PtyManager.emitChunks` (`pty.ts:243-247`), which base64s each 16 KiB slice
 * of raw bytes; it did not disappear. Encoding again here would send the base64
 * of the base64 text. Note the divergence from Rust is only *where* the encode
 * happens: `Outbound::TerminalData` carries `Vec<u8>` and the pump frames it, so
 * the Rust's `build_terminal_data_frame` takes bytes and encodes. Taking the
 * already-encoded string is the honest port of the same wire bytes.
 */
export function buildTerminalDataFrame(
  terminalId: string,
  data: string,
  timestamp: number,
): DataChannelMessage<TerminalDataMessage> {
  return {
    type: 'terminal-data',
    channel: 'terminal',
    payload: { terminalId, data },
    timestamp,
  } satisfies DataChannelMessage<TerminalDataMessage>;
}

/**
 * A `terminal-exit` frame. Mirrors Rust `frame_pty_exit` (`pty.rs:270-295`).
 *
 * `exitCode: null` is **written**, not omitted: see `TerminalExitPayload`.
 * `PtyManager` reports `null` when the process's exit event carried no code
 * (`pty.ts:204-221`).
 */
export function buildTerminalExitFrame(
  terminalId: string,
  exitCode: number | null,
  timestamp: number,
): DataChannelMessage<TerminalExitPayload> {
  return {
    type: 'terminal-exit',
    channel: 'terminal',
    payload: { terminalId, exitCode },
    timestamp,
  } satisfies DataChannelMessage<TerminalExitPayload>;
}

/**
 * A `terminal-error` frame. Mirrors Rust `frame_pty_error` (`pty.rs:80-101`).
 *
 * Without this frame a refused spawn is a blank terminal: the browser has no
 * other channel by which the agent can say a shell was refused, and the Rust's
 * comment says exactly that. `code` is the `PtyErrorCode` union `PtyManager`
 * already narrows to (`pty.ts:62-70`), whose two kebab-case spellings are a
 * pinned wire contract on both sides (`pty.rs:642`); this reuses it rather than
 * widening it to `string`.
 */
export function buildTerminalErrorFrame(
  terminalId: string,
  code: PtyErrorCode,
  message: string,
  timestamp: number,
): DataChannelMessage<TerminalErrorMessage> {
  return {
    type: 'terminal-error',
    channel: 'terminal',
    payload: { terminalId, code, message },
    timestamp,
  } satisfies DataChannelMessage<TerminalErrorMessage>;
}

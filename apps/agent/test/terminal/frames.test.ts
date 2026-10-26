// apps/agent/test/terminal/frames.test.ts
import type {
  DataChannelMessage,
  TerminalDataMessage,
  TerminalErrorMessage,
} from '@ponter/shared';
import { describe, expect, it } from 'vitest';
import {
  buildTerminalDataFrame,
  buildTerminalErrorFrame,
  buildTerminalExitFrame,
} from '../../src/terminal/frames.js';

describe('buildTerminalDataFrame', () => {
  it('emits the DataChannelMessage envelope on the terminal channel', () => {
    // The `channel` field is the whole point: a frame without it (or filed
    // under another label) is dropped by the browser's typed listener before
    // its payload is ever read (`webrtc-core/src/data-channel.ts:34-41` guards
    // `typeof parsed.type === 'string'` after the envelope arrives). Rust
    // stamps `channel: "terminal"` (`pty.rs:126-142`).
    const frame = buildTerminalDataFrame('t1', 'aGk=', 12_345);
    expect(frame.type).toBe('terminal-data');
    expect(frame.channel).toBe('terminal');
    expect(frame.timestamp).toBe(12_345);
    expect(frame.payload).toEqual({ terminalId: 't1', data: 'aGk=' });
  });

  it('carries the base64 it was handed, without encoding it again', () => {
    // `PtyManager.emitChunks` already base64-encodes raw bytes
    // (`pty.ts:243-247`), so the builder must be a pass-through. A second
    // `STANDARD.encode` here — the obvious "port the Rust literally" move —
    // would put the base64 of the base64 text on the wire and the terminal
    // would render `aGk=` instead of `hi`. The assertion is the reader's
    // decode, not "the field equals the argument".
    const raw = Buffer.from([0x00, 0xff, 0xc3, 0x68, 0x69]);
    const encoded = raw.toString('base64');
    const frame = buildTerminalDataFrame('t1', encoded, 1);
    expect(Buffer.from(frame.payload.data, 'base64').equals(raw)).toBe(true);
  });

  it('takes its timestamp from the caller, never from the clock', () => {
    // The Rust passes `timestamp_ms` in for exactly this reason (`pty.rs:141`).
    // A builder that reads `Date.now()` cannot be pinned, and two identical
    // calls would disagree.
    expect(buildTerminalDataFrame('t1', 'aGk=', 0)).toEqual(
      buildTerminalDataFrame('t1', 'aGk=', 0),
    );
    expect(buildTerminalDataFrame('t1', 'aGk=', 777).timestamp).toBe(777);
  });

  it('types its payload as the shared TerminalDataMessage', () => {
    // The type gate, not a comment: `@ponter/shared`'s payload type is what the
    // return value must satisfy, so the assignment below fails to compile if a
    // field is renamed or dropped.
    const frame = buildTerminalDataFrame('t1', 'aGk=', 1);
    const envelope: DataChannelMessage<TerminalDataMessage> = frame;
    expect(envelope.payload).toEqual({ terminalId: 't1', data: 'aGk=' });
  });
});

describe('buildTerminalExitFrame', () => {
  it('emits the envelope with the reaped exit code', () => {
    const frame = buildTerminalExitFrame('t1', 7, 999);
    expect(frame.type).toBe('terminal-exit');
    expect(frame.channel).toBe('terminal');
    expect(frame.timestamp).toBe(999);
    expect(frame.payload).toEqual({ terminalId: 't1', exitCode: 7 });
  });

  it('keeps the exitCode key with a null value when no code was reaped', () => {
    // Rust's `TerminalExitMessage.exit_code` is `Option<u32>` with **no**
    // `skip_serializing_if` (`pty.rs:270-274`), unlike Task 25's `DesktopStats`
    // (five of them, `desktop.rs:2111-2119`). So serde writes
    // `"exitCode": null` and the key is always present. Task 25 is the
    // counter-example, not this builder: omitting the key here would ship a
    // different wire contract from the Rust's.
    //
    // `channel` is asserted in this cell too because it is the field whose
    // absence makes the browser drop the frame silently, and this envelope is
    // built by its own code path — one shared assertion elsewhere covers
    // nothing.
    const frame = buildTerminalExitFrame('t1', null, 5);
    expect(frame.channel).toBe('terminal');
    expect('exitCode' in frame.payload).toBe(true);
    expect(frame.payload.exitCode).toBeNull();
  });
});

describe('buildTerminalErrorFrame', () => {
  it('names the failure with the pinned kebab-case code', () => {
    // The browser switches on these strings (`terminal-core/src/client.ts:327`),
    // so a rename is a breaking change nobody would notice. Rust pins the same
    // pair in `every_pty_error_code_has_the_kebab_case_wire_spelling`
    // (`pty.rs:642`), which had no TS counterpart before this cell.
    const frame = buildTerminalErrorFrame(
      't1',
      'pty-spawn-failed',
      'no such shell: /nope',
      3,
    );
    expect(frame.type).toBe('terminal-error');
    expect(frame.channel).toBe('terminal');
    expect(frame.timestamp).toBe(3);
    expect(frame.payload).toEqual({
      terminalId: 't1',
      code: 'pty-spawn-failed',
      message: 'no such shell: /nope',
    });
  });

  it('carries session-limit-reached unchanged', () => {
    const frame = buildTerminalErrorFrame(
      't1',
      'session-limit-reached',
      'too many',
      4,
    );
    expect(frame.payload.code).toBe('session-limit-reached');
    const payload: TerminalErrorMessage = frame.payload;
    expect(payload.terminalId).toBe('t1');
  });
});

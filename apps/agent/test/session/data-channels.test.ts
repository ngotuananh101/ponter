// apps/agent/test/session/data-channels.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_LABELS,
  DataChannelRouter,
} from '../../src/session/data-channels.js';
import type { InputEvent } from '../../src/input/decode.js';

function fakeChannel(label: string) {
  const handlers: Record<string, ((arg: never) => void)[]> = {};
  return {
    label,
    readyState: 'open',
    on: (event: string, cb: (arg: never) => void) => {
      (handlers[event] ??= []).push(cb);
      // The unsubscribe `RouterChannel.on` promises. Removing by identity is
      // what `detach`'s fix consumes; a fake that returns `undefined` would
      // make the detach test pass for the wrong reason again.
      return () => {
        const list = handlers[event] ?? [];
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      };
    },
    send: vi.fn(),
    close: vi.fn(),
    emit: (event: string, arg?: unknown) => {
      for (const cb of handlers[event] ?? []) cb(arg as never);
    },
    handlerCount: (event: string) => (handlers[event] ?? []).length,
  };
}

function router(overrides: Record<string, unknown> = {}) {
  const deps = {
    terminal: {
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      create: vi.fn(),
    },
    files: { handle: vi.fn(() => []), acceptBinaryChunk: vi.fn(() => []) },
    desktop: { onControl: vi.fn(), onSelect: vi.fn() },
    input: {
      // The Rust's three-stage input path, in its real order (`lib.rs:2427-2469`):
      // admit (gate + rate cap) → decode → apply. `admit` takes a timestamp and
      // never sees an event, which is what makes the order enforceable.
      admit: vi.fn(() => true),
      decode: vi.fn((): InputEvent | null => ({
        kind: 'pointer-move',
        x: 0.5,
        y: 0.5,
      })),
      apply: vi.fn(() => null),
    },
    send: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  // No `as never`: `deps` is the shape `RouterDeps` asks for, so the test
  // compiles against the real interface — that is the type-check that would
  // have caught `send` existing only as mocks (MAJOR-2).
  return { deps, r: new DataChannelRouter(deps) };
}

/**
 * Every browser-originated frame carries the `DataChannelMessage` envelope —
 * `webrtc-core`'s `sendJson` builds it for every channel — so the fixtures are
 * envelopes too. A flat fixture would now be dropped by R2's channel guard,
 * which is the behaviour the tests below assert on purpose.
 */
function envelope(
  channel: string,
  type: string,
  payload: Record<string, unknown> = {},
) {
  return new TextEncoder().encode(
    JSON.stringify({ type, channel, payload, timestamp: 0 }),
  );
}

describe('the label gate', () => {
  it('accepts each of the three served labels', () => {
    for (const label of Object.values(CHANNEL_LABELS)) {
      const { r } = router();
      const channel = fakeChannel(label);
      expect(() => r.attach(channel)).not.toThrow();
      expect(channel.close).not.toHaveBeenCalled();
    }
  });

  it('closes an unknown label with no code argument', () => {
    // Neither werift's `close()` nor the Rust's took a code. Passing one would
    // compile against a wider type and do nothing at runtime.
    const { r } = router();
    const channel = fakeChannel('admin');
    r.attach(channel);
    expect(channel.close).toHaveBeenCalledWith();
  });

  it('closes a SECOND channel with an already-registered label', () => {
    // Two `terminal` channels means two peers, or one confused one. Keeping both
    // would deliver output to whichever the browser happened to bind.
    const { r } = router();
    const first = fakeChannel('terminal');
    const second = fakeChannel('terminal');
    r.attach(first);
    r.attach(second);
    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).toHaveBeenCalledWith();
  });

  it('drops a channel whose label throws, without closing it', () => {
    const { r } = router();
    const channel = {
      // The annotation is required: a getter whose body always throws infers
      // `void`, which is not assignable to `RouterChannel.label: string`.
      get label(): string {
        throw new Error('not ready');
      },
      close: vi.fn(),
      on: vi.fn(),
      send: vi.fn(),
    };
    expect(() => r.attach(channel)).not.toThrow();
    expect(channel.close).not.toHaveBeenCalled();
  });
});

describe('dispatch', () => {
  it('routes a terminal-data frame to the pty by terminalId, as bytes', () => {
    // Ruling 1: the browser's only inbound terminal write is
    // `sendJson('terminal', 'terminal-data', { terminalId, data: base64 })`
    // (`terminal-core/src/client.ts:179,189`), and the Rust decodes
    // STANDARD base64 (`pty.rs:181-198`) before the pty sees it. `bHM=` is
    // "ls"; the write receives the **bytes**, not the base64 text.
    const { deps, r } = router();
    const channel = fakeChannel('terminal');
    r.attach(channel);
    channel.emit(
      'message',
      envelope('terminal', 'terminal-data', { terminalId: 't1', data: 'bHM=' }),
    );
    expect(deps.terminal.write).toHaveBeenCalledWith(
      't1',
      new Uint8Array([0x6c, 0x73]),
    );
  });

  it('drops a terminal-data frame with no terminalId rather than guessing a session', () => {
    // A terminal channel carries several pty sessions; `write` needs the id.
    // This is the dropped-frame's positive control for the test above.
    const { deps, r } = router();
    const channel = fakeChannel('terminal');
    r.attach(channel);
    channel.emit(
      'message',
      envelope('terminal', 'terminal-data', { data: 'bHM=' }),
    );
    expect(deps.terminal.write).not.toHaveBeenCalled();
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('routes a files binary 0x02 frame to the files session', () => {
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    const binary = new Uint8Array(26);
    binary[0] = 0x02;
    channel.emit('message', binary);
    expect(deps.files.acceptBinaryChunk).toHaveBeenCalledWith(binary);
  });

  it('routes a files JSON frame to the files session', () => {
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    // R2: the session receives the **unwrapped payload**, not the envelope.
    channel.emit('message', envelope('files', 'files-list', { path: '' }));
    expect(deps.files.handle).toHaveBeenCalledWith({
      path: '',
      type: 'files-list',
    });
  });

  it('sends whatever the files session returns, wrapped in the envelope, through the channel', () => {
    const { deps, r } = router({
      files: {
        handle: () => [{ type: 'files-error', code: 'BAD_FRAME' }],
        acceptBinaryChunk: () => [],
      },
    });
    const channel = fakeChannel('files');
    r.attach(channel);
    channel.emit('message', envelope('files', 'files-list', { path: '' }));
    // R1: a flat frame is what produced the silent hang. The framed shape is
    // `{ type, channel: 'files', payload, timestamp }`. The wrap happens in
    // `emit`, the write happens in the router's own `send` — so the observable
    // is the channel's `send`, not `deps.send` (which is the test seam the
    // runtime binds; MAJOR-2).
    expect(deps.send).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'files-error',
        channel: 'files',
        payload: { type: 'files-error', code: 'BAD_FRAME' },
        timestamp: 1_700_000_000_000,
      }),
    );
  });

  it('leaves a binary chunk frame unwrapped on the way out', () => {
    // `frameFiles` is the JSON path; a chunk frame is `Uint8Array` and the
    // browser's raw handler reads it as bytes. Wrapping it would put a
    // `Uint8Array` inside a JSON string. The **inbound** fixture is the
    // binary upload chunk itself (`0x02`, `packages/shared/src/types/
    // files.ts:121`, `BINARY_TYPE_UPLOAD_CHUNK`) — a JSON envelope cannot
    // reach `acceptBinaryChunk`, so emitting one here would test the wrong
    // arm; the outbound frame the session returns is the chunk and it must
    // reach the channel untouched.
    const binary = new Uint8Array(25 + 4);
    binary[0] = 0x02;
    const { deps, r } = router({
      files: { handle: () => [], acceptBinaryChunk: () => [binary] },
    });
    const channel = fakeChannel('files');
    r.attach(channel);
    channel.emit('message', binary);
    expect(deps.send).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledWith(binary);
  });

  it('drops a frame whose wire channel does not match the label', () => {
    // R2: the Rust drops a misfiled frame (`files.rs:590-592`). Without this
    // the plan handled a `files-list` filed under `terminal` as a files frame.
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    channel.emit('message', envelope('terminal', 'files-list', { path: '' }));
    expect(deps.files.handle).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('drops a frame that carries no envelope at all', () => {
    // A flat frame is not this contract's sender: every browser channel goes
    // through `sendJson`, which emits the envelope.
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    channel.emit(
      'message',
      new TextEncoder().encode('{"type":"files-list","path":""}'),
    );
    expect(deps.files.handle).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('drops an inbound frame over the data-channel cap without decoding it', () => {
    // R4: `MAX_DATA_CHANNEL_FRAME_BYTES` was pinned at `:1105` and enforced
    // nowhere. 64 KiB + 1 is above the SCTP message cap the browser also
    // enforces, so a conforming peer could not have sent it.
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    const huge = new Uint8Array(64 * 1024 + 1);
    huge[0] = 0x02;
    channel.emit('message', huge);
    expect(deps.files.acceptBinaryChunk).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('accepts an inbound frame exactly at the cap', () => {
    // The positive control for the test above: without it, a cap of `0` would
    // pass the "drops an oversized frame" case just as well.
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    const atCap = new Uint8Array(64 * 1024);
    atCap[0] = 0x02;
    channel.emit('message', atCap);
    expect(deps.files.acceptBinaryChunk).toHaveBeenCalledWith(atCap);
  });

  it('routes desktop-select and desktop-bitrate on the control channel', () => {
    // BLOCKING-2: the browser sends both on `control` —
    // `sendJson('control', 'desktop-select', { sourceId })` and
    // `sendJson('control', 'desktop-bitrate', { bitrateBps })`
    // (`desktop-core/src/client.ts:423-430`). `sourceId` is the scheme string
    // the Rust carries verbatim (`desktop.rs:2951-2962`), and the bitrate is
    // clamped at this boundary with Task 17's clamp (the Rust clamps inside
    // `decode_control` too, `desktop.rs:2015-2019`).
    const { deps, r } = router();
    const channel = fakeChannel('control');
    r.attach(channel);
    channel.emit(
      'message',
      envelope('control', 'desktop-select', { sourceId: 'window:0x4a00007' }),
    );
    expect(deps.desktop.onSelect).toHaveBeenCalledWith('window:0x4a00007');
    channel.emit(
      'message',
      envelope('control', 'desktop-bitrate', { bitrateBps: 99_000_000 }),
    );
    expect(deps.desktop.onControl).toHaveBeenCalledWith({
      kind: 'bitrate',
      bitrate: 20_000_000,
    });
    channel.emit(
      'message',
      envelope('control', 'desktop-bitrate', { bitrateBps: 3_000_000 }),
    );
    expect(deps.desktop.onControl).toHaveBeenCalledWith({
      kind: 'bitrate',
      bitrate: 3_000_000,
    });
  });

  it('closes an unknown label the browser never opens — including a real label from the shared type this port does not serve', () => {
    // `'desktop'` is the capability string and the RTP media label
    // (`packages/shared/src/types/webrtc.ts:7` lists it), not a data channel
    // any peer opens — the browser opens only `terminal`, `control`, `files`
    // (`terminal.ts:544`, `:937`, `:1128`). If a peer ever offered one, the
    // Rust would refuse it too (`rtc.rs:663-689` closes any label that is not
    // the session's accepted one), so closing is the ported behaviour.
    const { r } = router();
    const channel = fakeChannel('desktop');
    r.attach(channel);
    expect(channel.close).toHaveBeenCalledWith();
  });

  it('runs admit before decode before apply, on the control channel', () => {
    // MAJOR-5: the order is the DoS property and it is the Rust's. The gate and
    // the rate cap run BEFORE the JSON parser (`lib.rs:2428-2430` — *"cap
    // AFTER decrypt and the Gate-A check, BEFORE decode/inject"*), then
    // `apply_if_allowed` decodes and injects (`input.rs:277-286`). The earlier
    // version of this test asserted `['decode']` and called that "the order
    // the Rust established" — backwards on both counts. `decode` returns a real
    // event here so the third stage is reached: a `null` decode would stop the
    // chain and the assertion could not tell "apply runs third" from "apply
    // never runs".
    const order: string[] = [];
    const { r } = router({
      input: {
        admit: () => {
          order.push('admit');
          return true;
        },
        decode: () => {
          order.push('decode');
          return { kind: 'pointer-move', x: 0.5, y: 0.5 };
        },
        apply: () => {
          order.push('apply');
          return 7;
        },
      },
    });
    const channel = fakeChannel('control');
    r.attach(channel);
    channel.emit(
      'message',
      envelope('control', 'desktop-input', {
        kind: 'pointer-move',
        x: 0.5,
        y: 0.5,
      }),
    );
    expect(order).toEqual(['admit', 'decode', 'apply']);
  });

  it('never decodes a frame the cap refused — admit alone is the only witness', () => {
    // The discriminating half. A test that only runs admit-true cannot tell
    // "admit is first" from "admit is called at all"; with `admit` refusing,
    // decode and apply must not run — the frame is dropped before the parser.
    const order: string[] = [];
    const { r } = router({
      input: {
        admit: () => {
          order.push('admit');
          return false;
        },
        decode: () => {
          order.push('decode');
          return null;
        },
        apply: () => {
          order.push('apply');
          return null;
        },
      },
    });
    const channel = fakeChannel('control');
    r.attach(channel);
    channel.emit(
      'message',
      envelope('control', 'desktop-input', {
        kind: 'pointer-move',
        x: 0.5,
        y: 0.5,
      }),
    );
    expect(order).toEqual(['admit']);
  });

  it('logs and ignores a corrupt JSON frame on any channel', () => {
    const { deps, r } = router();
    const channel = fakeChannel('control');
    r.attach(channel);
    expect(() =>
      channel.emit('message', new TextEncoder().encode('{oops')),
    ).not.toThrow();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('detach removes the handlers so a late message is ignored', () => {
    // MAJOR-3's restored discriminating fixture. The gate must be **satisfied**
    // — `type` on the envelope, an object payload — so the frame reaches the
    // dispatch arm, and the assertion then measures `detach` and nothing else:
    // with the landed code (which kept the handler), this same fixture produces
    // writes=1 after detach; with the fix, 0. The type is `terminal-data`
    // because `terminal-input` has no producer anywhere on the wire.
    const { deps, r } = router();
    const channel = fakeChannel('terminal');
    r.attach(channel);
    r.detach('terminal');
    channel.emit(
      'message',
      envelope('terminal', 'terminal-data', { terminalId: 't1', data: 'eA==' }),
    );
    expect(deps.terminal.write).not.toHaveBeenCalled();
    expect(channel.handlerCount('message')).toBe(0);
  });

  it('send() writes through to the attached channel and warns when the channel is absent', () => {
    // MAJOR-2's production `send`. The positive control for the absent case:
    // with the channel attached the JSON string reaches `channel.send`
    // (werift accepts `Buffer | string`); detached, the frame is warned and
    // dropped rather than thrown into the caller's loop.
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    r.send('files', { type: 'files-error', code: 'BAD_FRAME' });
    expect(channel.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'files-error', code: 'BAD_FRAME' }),
    );
    r.detach('files');
    r.send('files', { type: 'files-error', code: 'BAD_FRAME' });
    expect(deps.logger.warn).toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('send() hands a binary frame to the channel untouched', () => {
    // The binary half of `send`: an upload-chunk frame that comes back out
    // (download path) must not be JSON-stringified.
    const { r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    r.send('files', new Uint8Array([0x01, 2, 3]));
    expect(channel.send).toHaveBeenCalledWith(new Uint8Array([0x01, 2, 3]));
  });

  it('send() does not double-encode an already-serialised frame (MAJOR-3)', () => {
    // Task 17's builders return `JSON.stringify(…)`, so this is the shape that
    // actually reaches `send()` on the control channel. The assertion is the
    // reader's operation, not "was called": the browser parses exactly once
    // (`webrtc-core/src/data-channel.ts:36`) and gates on
    // `typeof parsed.type === 'string'`. Double-encoding makes `parsed` the
    // *string* of the JSON, so `parsed.type` is `undefined` and every
    // `desktop-*` frame is dropped by the browser with no error at either end.
    // `parsed` must be an object, and its `type` must survive.
    const { r } = router();
    const channel = fakeChannel('control');
    r.attach(channel);
    const frame = JSON.stringify({ type: 'desktop-stats', data: { fps: 30 } });
    r.send('control', frame);
    const wire = channel.send.mock.calls[0]?.[0] as string;
    const parsed: unknown = JSON.parse(wire);
    expect(typeof parsed).toBe('object');
    expect((parsed as Record<string, unknown>).type).toBe('desktop-stats');
    // And the string is on the wire unmodified, not re-wrapped.
    expect(wire).toBe(frame);
  });
});

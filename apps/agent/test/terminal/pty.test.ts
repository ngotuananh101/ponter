// apps/agent/test/terminal/pty.test.ts
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MAX_SESSIONS, PtyManager } from '../../src/terminal/pty.js';
import { ShellPolicy } from '../../src/terminal/shell-policy.js';

/** Every temp dir this file creates, removed once the file finishes. */
const TMP_DIRS: string[] = [];
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

/**
 * The operator's policy, as production builds it (Task 31 defect C:
 * `PtyCreateOptions.policy` is required, so every cell must state one).
 * `/bin/sh` is on the POSIX floor and canonicalises, so this allows the shell
 * those cells spawn and nothing else in the temp dirs.
 */
const OPERATOR_POLICY = new ShellPolicy({ configured: '/bin/sh' });

// `recursive` because the fixture writes files; `force` so a cell that already
// removed its own path cannot fail the file from a teardown.
afterAll(() => {
  for (const dir of TMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

function fakeHost() {
  const spawned: {
    file: string;
    args: string[];
    opts: Record<string, unknown>;
  }[] = [];
  const procs: (EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  })[] = [];
  const host = {
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
      spawned.push({ file, args, opts });
      const emitter = new EventEmitter();
      const p = Object.assign(emitter, {
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        pid: 1000 + procs.length,
        onData: (cb: (chunk: string | Buffer) => void) => {
          emitter.on('data', cb);
        },
        onExit: (cb: (event: { exitCode?: number }) => void) => {
          emitter.on('exit', cb);
        },
      });
      procs.push(p);
      return p;
    },
  };
  return { host, spawned, procs };
}

describe('PtyManager.create', () => {
  /**
   * The compile-time gate for `PtyCreateOptions.policy`.
   *
   * The runtime-level gate (in `test/runtime.test.ts`) pins `RuntimeDeps.shellPolicy`,
   * but that is the *outer* face. This is the *inner* one: the spawn options
   * themselves. Measured, both poles: with `policy` optional again, this
   * directive becomes `TS2578: Unused '@ts-expect-error' directive` and `tsc`
   * exits 2 — so the "there is no object shape in which a peer shell reaches
   * `spawn` unvalidated" claim is enforced by the compiler, not by a runtime
   * cell that could pass for another reason.
   *
   * The directive sits above the **argument**, not above the missing property:
   * `tsc` reports a missing required property against the whole argument
   * (`TS2345 … Property 'policy' is missing`), so a directive on the trailing
   * property is unused and the gate never fires.
   *
   * As with the runtime gate, this is enforced by `tsc` only — vitest does not
   * typecheck — and `apps/agent` is excluded from the CI test matrix, so the
   * cell is inert unless typecheck runs.
   */
  it('cannot be called without a policy (compile-time gate, and refuses at runtime)', async () => {
    const { host, spawned } = fakeHost();
    const manager = new PtyManager(host);
    const call = () =>
      manager.create(
        // @ts-expect-error — `policy` is required on `PtyCreateOptions`;
        // supplying spawn options without one must not compile. If this
        // directive ever becomes unused, a peer-supplied shell can reach
        // `spawn` unvalidated again.
        {
          terminalId: 't1',
          shell: '/bin/sh',
          cols: 80,
          rows: 24,
          shellSource: 'peer' as const,
        },
      );
    // **The compiler is one tooth; this is the other.** An earlier version of
    // this cell asserted `typeof call === 'function'` and never called it — an
    // assertion with no failure mode, true for any function, i.e. a no-op.
    // Calling it gives the cell the failure mode that matters: `policy` is
    // `undefined`, so `resolveClientShell` is dereferenced on `undefined` and
    // the refusal is re-thrown as the pinned `pty-spawn-failed` **before any
    // spawn**. Restore the original defect (a policy consulted only when
    // present, `options.policy ? … : options.shell`) and this call resolves and
    // spawns instead — `rejects` fails, `spawned` is non-empty. Measured; see
    // the task-31 report.
    await expect(call()).rejects.toMatchObject({ code: 'pty-spawn-failed' });
    expect(spawned).toHaveLength(0);
  });

  it('spawns with the documented TERM and LANG', async () => {
    const { host, spawned } = fakeHost();
    const manager = new PtyManager(host);
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      shellSource: 'peer' as const,
      policy: OPERATOR_POLICY,
    });
    expect(spawned[0]!.opts).toMatchObject({
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: expect.objectContaining({ TERM: 'xterm-256color', LANG: 'C.UTF-8' }),
      // Bytes, not text: a utf8-decoding host loses 0xff before base64 runs.
      encoding: null,
    });
  });

  it('is idempotent per terminal id', async () => {
    const { host, spawned } = fakeHost();
    const manager = new PtyManager(host);
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      shellSource: 'peer' as const,
      policy: OPERATOR_POLICY,
    });
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      shellSource: 'peer' as const,
      policy: OPERATOR_POLICY,
    });
    expect(spawned).toHaveLength(1);
  });

  // Only the literal `10` is asserted. "The prod cap equals the constant"
  // is NOT asserted, because in TS both sides are the same symbol — asserting
  // that `MAX_SESSIONS` equals itself cannot fail. Rust could assert the
  // equivalent by passing a literal to its constructor (`PtyManager::new(1)`);
  // TS made the cap a module constant, so only asserting against the literal
  // wire value `10` makes the assertion non-circular.
  it('pins the session cap to the wire value', () => {
    expect(MAX_SESSIONS).toBe(10);
  });

  it('refuses an 11th session with session-limit-reached', async () => {
    const { host } = fakeHost();
    const manager = new PtyManager(host);
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      await manager.create({
        terminalId: `t${i}`,
        shell: '/bin/sh',
        cols: 80,
        rows: 24,
        shellSource: 'peer' as const,
        policy: OPERATOR_POLICY,
      });
    }
    await expect(
      manager.create({
        terminalId: 'overflow',
        shell: '/bin/sh',
        cols: 80,
        rows: 24,
        shellSource: 'peer' as const,
        policy: OPERATOR_POLICY,
      }),
    ).rejects.toMatchObject({ code: 'session-limit-reached' });
  });

  it('frees a slot when a session exits', async () => {
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      await manager.create({
        terminalId: `t${i}`,
        shell: '/bin/sh',
        cols: 80,
        rows: 24,
        shellSource: 'peer' as const,
        policy: OPERATOR_POLICY,
      });
    }
    procs[0]!.emit('exit', { exitCode: 0 });
    await expect(
      manager.create({
        terminalId: 'after-exit',
        shell: '/bin/sh',
        cols: 80,
        rows: 24,
        shellSource: 'peer' as const,
        policy: OPERATOR_POLICY,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('PtyManager output', () => {
  it('base64-encodes arbitrary bytes without a UTF-8 round trip', async () => {
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    const frames: { terminalId: string; data: string }[] = [];
    manager.onData((f) => frames.push(f));
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      shellSource: 'peer' as const,
      policy: OPERATOR_POLICY,
    });
    procs[0]!.emit('data', Buffer.from([0x00, 0xff, 0xc3]));
    expect(frames[0]!.data).toBe(
      Buffer.from([0x00, 0xff, 0xc3]).toString('base64'),
    );
  });

  it('splits more than 16 KiB of output into two frames', async () => {
    // The Rust's `chunk_boundaries` promised this and never exercised it: it
    // built one synthesized frame per length and asserted length equality. This
    // is a real chunking assertion, made against the manager's own splitter.
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    const frames: { terminalId: string; data: string }[] = [];
    manager.onData((f) => frames.push(f));
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      shellSource: 'peer' as const,
      policy: OPERATOR_POLICY,
    });
    procs[0]!.emit('data', Buffer.alloc(16 * 1024 + 100, 0x41));
    expect(frames).toHaveLength(2);
    expect(Buffer.from(frames[0]!.data, 'base64').length).toBe(16 * 1024);
    expect(Buffer.from(frames[1]!.data, 'base64').length).toBe(100);
  });

  it('emits terminal-exit with the reaped code', async () => {
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    const exits: { terminalId: string; exitCode: number | null }[] = [];
    manager.onExit((e) => exits.push(e));
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      shellSource: 'peer' as const,
      policy: OPERATOR_POLICY,
    });
    procs[0]!.emit('exit', { exitCode: 3 });
    expect(exits).toEqual([{ terminalId: 't1', exitCode: 3 }]);
  });

  it('reports an unavailable exit code as null', async () => {
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    const exits: { terminalId: string; exitCode: number | null }[] = [];
    manager.onExit((e) => exits.push(e));
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      shellSource: 'peer' as const,
      policy: OPERATOR_POLICY,
    });
    procs[0]!.emit('exit', {});
    expect(exits[0]!.exitCode).toBeNull();
  });
});

describe('PtyManager.write', () => {
  it('hands the host the same bytes it was given', async () => {
    // `bytes.toString('utf8')` would look right here and pass a naive test,
    // because 'echo' is valid UTF-8. The input below is not: 0xff and 0xfe are
    // invalid UTF-8 leads, and the utf8 round trip turns each into U+FFFD
    // (`ef bf bd`). ADR-10 says the payload is bytes.
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      shellSource: 'peer' as const,
      policy: OPERATOR_POLICY,
    });
    manager.write('t1', Buffer.from([0x41, 0xff, 0xfe, 0x42]));
    const passed = procs[0]!.write.mock.calls[0]![0] as Buffer;
    expect(Buffer.isBuffer(passed)).toBe(true);
    expect(passed.equals(Buffer.from([0x41, 0xff, 0xfe, 0x42]))).toBe(true);
  });

  it('drops input for an unknown terminal instead of throwing', () => {
    const { host } = fakeHost();
    const manager = new PtyManager(host);
    expect(() => manager.write('nope', Buffer.from('x'))).not.toThrow();
  });

  it('resizes an existing terminal and ignores an unknown one', async () => {
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      shellSource: 'peer' as const,
      policy: OPERATOR_POLICY,
    });
    manager.resize('t1', 120, 40);
    expect(procs[0]!.resize).toHaveBeenCalledWith(120, 40);
    expect(() => manager.resize('nope', 1, 1)).not.toThrow();
  });
});

describe('PtyManager.closeAll', () => {
  it('kills every live session and leaves no slot occupied', async () => {
    // B41's lifecycle half: `AgentRuntime.stop()` promises "pty sessions" are
    // torn down before the socket (its own docblock), and a pty that outlives
    // the socket leaves an orphan shell on the host. Without this method the
    // runtime can only close ids it happens to remember, which it cannot:
    // the ids come from the peer.
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    for (const id of ['a', 'b']) {
      await manager.create({
        terminalId: id,
        shell: '/bin/sh',
        cols: 80,
        rows: 24,
        shellSource: 'peer' as const,
        policy: OPERATOR_POLICY,
      });
    }
    // The positive control: both are live now, so a `closeAll` that kills
    // nothing cannot pass by the fixture being empty.
    manager.write('a', Buffer.from('x'));
    manager.write('b', Buffer.from('x'));
    expect(procs[0]!.write).toHaveBeenCalledTimes(1);
    expect(procs[1]!.write).toHaveBeenCalledTimes(1);

    manager.closeAll();

    expect(procs[0]!.kill).toHaveBeenCalledTimes(1);
    expect(procs[1]!.kill).toHaveBeenCalledTimes(1);
    // The registry is what the 10-session cap reads: an emptied map means the
    // next peer to connect starts from 10 free slots, not 8.
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      await manager.create({
        terminalId: `fresh${i}`,
        shell: '/bin/sh',
        cols: 80,
        rows: 24,
        shellSource: 'peer' as const,
        policy: OPERATOR_POLICY,
      });
    }
    expect(procs).toHaveLength(MAX_SESSIONS + 2);
  });

  it('is a no-op on a manager with no sessions', () => {
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    expect(() => manager.closeAll()).not.toThrow();
    expect(procs).toHaveLength(0);
  });

  it('does not emit a terminal-exit for a session it closed itself', async () => {
    // The SIGTERM this issues may produce an exit event on a real host, but
    // the browser asked for the close and already dropped its session — an
    // exit frame would re-open a terminal the operator just closed. The
    // manager does not fake one: it reports only events the host delivers,
    // and the runtime's `closeAll` ordering means the channel is gone anyway.
    const { host } = fakeHost();
    const manager = new PtyManager(host);
    const exits: unknown[] = [];
    manager.onExit((e) => exits.push(e));
    await manager.create({
      terminalId: 'a',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      shellSource: 'peer' as const,
      policy: OPERATOR_POLICY,
    });
    manager.closeAll();
    expect(exits).toEqual([]);
  });
});

/** A host whose first spawn returns a process that cannot be subscribed to. */
function brokenFirstHost() {
  const procs: (EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  })[] = [];
  const host = {
    spawn: () => {
      const emitter = new EventEmitter();
      const broken = procs.length === 0;
      // The first process's subscription surface throws — what a host adapter
      // written against `on` instead of the declared `onData`/`onExit` does at
      // runtime. Throwing rather than omitting keeps the fake statically a
      // `PtyProcess`, so the seam needs no cast; the failure is real at run
      // time, which is where the manager must survive it.
      const p = Object.assign(emitter, {
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        onData: (cb: (chunk: string | Buffer) => void) => {
          if (broken) throw new TypeError('process_.onData is not a function');
          emitter.on('data', cb);
        },
        onExit: (cb: (event: { exitCode?: number }) => void) => {
          if (broken) throw new TypeError('process_.onExit is not a function');
          emitter.on('exit', cb);
        },
      });
      procs.push(p);
      return p;
    },
  };
  return { host, procs };
}

describe('PtyManager.create lifecycle (defects 5, 6, 7)', () => {
  it('does not leak a slot when a subscription throws (defect 5)', async () => {
    // Registering the slot before subscribing leaves an entry no exit event
    // will ever remove, so the agent silently offers 9 sessions for the rest of
    // its life and refuses the 10th to a peer that opened nothing.
    const { host, procs } = brokenFirstHost();
    const manager = new PtyManager(host);
    await expect(
      manager.create({
        terminalId: 'broken',
        shell: '/bin/sh',
        cols: 80,
        rows: 24,
        shellSource: 'peer' as const,
        policy: OPERATOR_POLICY,
      }),
    ).rejects.toMatchObject({ code: 'pty-spawn-failed' });
    // The unusable process is killed rather than left running unobserved.
    expect(procs[0]!.kill).toHaveBeenCalled();

    let accepted = 0;
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      await manager.create({
        terminalId: `s${i}`,
        shell: '/bin/sh',
        cols: 80,
        rows: 24,
        shellSource: 'peer' as const,
        policy: OPERATOR_POLICY,
      });
      accepted += 1;
    }
    expect(accepted).toBe(MAX_SESSIONS);
  });

  it('does not let a closed process evict the live session reusing its id (defect 6)', async () => {
    // `close()` drops the map entry but cannot unsubscribe, so the old
    // process's exit handler outlives it. Without an identity check it deletes
    // whatever now lives under the id: the re-created terminal goes silent
    // while the browser still shows it open.
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    const exits: { terminalId: string; exitCode: number | null }[] = [];
    manager.onExit((e) => exits.push(e));

    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      shellSource: 'peer' as const,
      policy: OPERATOR_POLICY,
    });
    await manager.close('t1');
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      shellSource: 'peer' as const,
      policy: OPERATOR_POLICY,
    });
    expect(procs).toHaveLength(2);

    procs[0]!.emit('exit', { exitCode: 0 });

    // The stale exit is still REPORTED — Rust reports the exit and only guards
    // the eviction — but the live session survives and still receives input.
    expect(exits).toEqual([{ terminalId: 't1', exitCode: 0 }]);
    manager.write('t1', Buffer.from('still-alive'));
    expect(procs[1]!.write).toHaveBeenCalledTimes(1);
  });

  function policyFor(configured: string) {
    return new ShellPolicy({ configured });
  }

  it('refuses a shell the policy disallows, before any spawn (defect 7)', async () => {
    // Task 9's allowlist had no caller in `src/`, so any client-supplied shell
    // spawned. The Rust consults it in the dispatcher before `spawn_session`
    // and answers with the pinned spawn-failure frame (`lib.rs:1372-1400`).
    //
    // The refused candidate is a **real, executable, resolvable** file that is
    // simply not on the allowlist — not `/etc/passwd`, which fails the earlier
    // executable-bit arm and would pass this test even with the allowlist
    // membership check deleted.
    const outside = tmpDir('ponter-shell-');
    const candidate = join(outside, 'evil.sh');
    writeFileSync(candidate, '#!/bin/sh\n', { mode: 0o755 });
    const { host, spawned } = fakeHost();
    const manager = new PtyManager(host);
    await expect(
      manager.create({
        terminalId: 't1',
        shell: candidate,
        cols: 80,
        rows: 24,
        shellSource: 'peer' as const,
        policy: policyFor(realpathSync('/bin/sh')),
      }),
    ).rejects.toMatchObject({ code: 'pty-spawn-failed' });
    expect(spawned).toHaveLength(0);
  });

  it('spawns the canonical path the policy resolved (defect 7)', async () => {
    const { host, spawned } = fakeHost();
    const manager = new PtyManager(host);
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      shellSource: 'peer' as const,
      policy: policyFor(realpathSync('/bin/sh')),
    });
    expect(spawned[0]!.file).toBe(realpathSync('/bin/sh'));
  });
});

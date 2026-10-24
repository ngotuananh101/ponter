// apps/agent/test/terminal/pty.test.ts
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_SESSIONS, PtyManager } from '../../src/terminal/pty.js';
import { ShellPolicy } from '../../src/terminal/shell-policy.js';

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
  it('spawns with the documented TERM and LANG', async () => {
    const { host, spawned } = fakeHost();
    const manager = new PtyManager(host);
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
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
    });
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
    });
    expect(spawned).toHaveLength(1);
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
      });
    }
    await expect(
      manager.create({
        terminalId: 'overflow',
        shell: '/bin/sh',
        cols: 80,
        rows: 24,
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
      });
    }
    procs[0]!.emit('exit', { exitCode: 0 });
    await expect(
      manager.create({
        terminalId: 'after-exit',
        shell: '/bin/sh',
        cols: 80,
        rows: 24,
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
    });
    manager.resize('t1', 120, 40);
    expect(procs[0]!.resize).toHaveBeenCalledWith(120, 40);
    expect(() => manager.resize('nope', 1, 1)).not.toThrow();
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
    });
    await manager.close('t1');
    await manager.create({
      terminalId: 't1',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
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
    const outside = mkdtempSync(join(tmpdir(), 'ponter-shell-'));
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
      policy: policyFor(realpathSync('/bin/sh')),
    });
    expect(spawned[0]!.file).toBe(realpathSync('/bin/sh'));
  });
});

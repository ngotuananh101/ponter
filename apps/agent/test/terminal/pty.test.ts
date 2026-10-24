// apps/agent/test/terminal/pty.test.ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { MAX_SESSIONS, PtyManager } from '../../src/terminal/pty.js';

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

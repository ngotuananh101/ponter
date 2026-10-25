// apps/agent/test/terminal/pty-real.test.ts
import { describe, expect, it } from 'vitest';
import { PtyManager } from '../../src/terminal/pty.js';
import { ShellPolicy } from '../../src/terminal/shell-policy.js';

describe('a real shell', () => {
  it('echoes, then delivers terminal-exit after the child exits', async () => {
    const { spawn } = await import('node-pty');
    const manager = new PtyManager({ spawn });
    const data: string[] = [];
    const exits: number[] = [];
    manager.onData((f) => data.push(f.data));
    manager.onExit((e) => exits.push(e.exitCode ?? -1));
    await manager.create({
      terminalId: 't',
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      // A peer-requested shell, resolved through the real policy. Task 31's
      // defect C made both fields required; this cell spawns the shell the
      // policy allows, so the real `node-pty` path is still exercised.
      shellSource: 'peer',
      policy: new ShellPolicy({ configured: '/bin/sh' }),
    });
    manager.write('t', Buffer.from('echo PONTER_E2E\n'));
    await new Promise((r) => setTimeout(r, 300));
    expect(
      Buffer.concat(data.map((d) => Buffer.from(d, 'base64'))).toString(),
    ).toContain('PONTER_E2E');
    manager.write('t', Buffer.from('exit 7\n'));
    await new Promise((r) => setTimeout(r, 300));
    expect(exits).toEqual([7]);
  });
});

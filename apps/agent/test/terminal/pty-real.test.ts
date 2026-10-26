// apps/agent/test/terminal/pty-real.test.ts
import { describe, expect, it } from 'vitest';
import { PtyManager } from '../../src/terminal/pty.js';
import { ShellPolicy } from '../../src/terminal/shell-policy.js';

// Wait for the condition, not for a duration. A fixed `setTimeout(300)` here is
// red under concurrent load -- measured on a 16-core machine with the whole
// workspace running in parallel: the child's exit arrives at 600 ms, not at
// 300 ms. The event is never lost; the sleep is simply a guess at how long a
// real process takes, and the guess is wrong whenever the event loop is busy.
//
// The ceiling is generous on purpose, and it is a *failure bound*, not a wait:
// the poll returns as soon as the condition holds, so a healthy run costs one
// tick. Only a genuinely missing event spends the full budget before failing.
const waitFor = async (
  predicate: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
};

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
    await waitFor(
      () =>
        Buffer.concat(data.map((d) => Buffer.from(d, 'base64')))
          .toString()
          .includes('PONTER_E2E'),
      'the shell to echo PONTER_E2E',
    );
    expect(
      Buffer.concat(data.map((d) => Buffer.from(d, 'base64'))).toString(),
    ).toContain('PONTER_E2E');
    manager.write('t', Buffer.from('exit 7\n'));
    await waitFor(() => exits.length > 0, 'the child to exit');
    expect(exits).toEqual([7]);
  });
});

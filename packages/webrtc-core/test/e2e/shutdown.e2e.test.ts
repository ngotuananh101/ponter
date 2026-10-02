import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { AGENT_BIN, isLinux } from './harness';

/**
 * The signaling port for this file. Distinct from the harness server's 8787
 * so the two never collide (the e2e config runs files sequentially, but a
 * dedicated port keeps this test self-contained).
 */
const PORT = 8896;
const SERVER_URL = `ws://127.0.0.1:${PORT}/api/ws/agent`;

/** Spawn the real binary and buffer its output. */
function spawnAgentForShutdown(): {
  child: ChildProcess;
  output: () => string;
} {
  const child = spawn(
    AGENT_BIN,
    [
      '--agent-id',
      'shutdown-e2e',
      '--server',
      SERVER_URL,
      '--credential',
      'ag_shutdown_e2e_0000000000000000',
      '--stun',
      '',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const chunks: string[] = [];
  child.stdout?.on('data', (c: Buffer) => chunks.push(c.toString()));
  child.stderr?.on('data', (c: Buffer) => chunks.push(c.toString()));
  return { child, output: () => chunks.join('') };
}

/** Poll `condition` until it is true, or fail with the agent's log. */
async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs: number,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}\n${output()}`);
}

/**
 * Ctrl-C must end the agent even when the signaling handshake never returns.
 *
 * The bug: `SignalClient::connect(...).await` sat outside every `select!`, so
 * while the WebSocket upgrade was in flight no `shutdown_signal()` future was
 * being polled. On Unix the tokio SIGINT/SIGTERM handler is installed
 * process-wide and delivery is a one-shot broadcast — a signal that arrives
 * with no listener registered is dropped, and installing the handler replaces
 * the default "terminate" disposition. So a Ctrl-C during a hanging connect
 * was swallowed, and every later Ctrl-C with it: the UI's socket had closed
 * (the process looked offline) but the agent lived on. This is the production
 * report of 2026-10-02 (ICE connected, TURN/STUN timed out, then `^C^C^C^C^C^C`
 * and no exit).
 *
 * The test reaches the hanging-connect window deterministically: it first
 * lets the agent fail a connect to a closed port (the backoff select installs
 * the tokio handler), then brings up a TCP listener that accepts the
 * connection but never answers the HTTP upgrade.
 */
describe.skipIf(!isLinux)('agent shutdown', () => {
  it('exits on SIGINT while the signaling handshake is hanging', async () => {
    let blackhole: Server | undefined;
    const sockets: Socket[] = [];
    const agent = spawnAgentForShutdown();

    try {
      // 1. Fail the first connect (nothing is listening yet). The agent logs
      //    "reconnecting" and enters the backoff select, which polls
      //    `shutdown_signal()` and so installs the tokio signal handler.
      await waitFor(
        () => agent.output().includes('reconnecting'),
        'the agent to enter its first reconnect',
        10_000,
        agent.output,
      );

      // 2. Accept TCP but never complete the WebSocket upgrade, so the next
      //    connect attempt hangs inside `connect_async`.
      let accepted = false;
      blackhole = createServer((socket) => {
        accepted = true;
        sockets.push(socket);
        socket.on('data', () => {}); // swallow the upgrade request
      });
      await new Promise<void>((resolve) => blackhole!.listen(PORT, resolve));

      await waitFor(
        () => accepted,
        'the agent to enter the hanging connect',
        10_000,
        agent.output,
      );

      // 3. Ctrl-C must end the process even though the handshake never
      //    returns.
      const exited = new Promise<number | NodeJS.Signals | null>((resolve) => {
        agent.child.once('exit', (code, signal) => resolve(code ?? signal));
      });
      agent.child.kill('SIGINT');

      const result = await Promise.race([
        exited,
        delay(5_000).then(() => null),
      ]);

      expect(
        result,
        `the agent did not exit after SIGINT while connecting\n${agent.output()}`,
      ).not.toBeNull();
    } finally {
      try {
        agent.child.kill('SIGKILL');
      } catch {
        // already gone
      }
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // already destroyed
        }
      }
      if (blackhole) {
        await new Promise<void>((resolve) => blackhole!.close(() => resolve()));
      }
    }
  }, 30_000);
});

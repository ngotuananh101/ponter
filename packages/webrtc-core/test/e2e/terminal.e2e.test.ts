import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PeerConnection } from '../../src/connection';
import { WeriftAdapter } from '../../src/adapters/werift';
import { RESTPollingTransport } from '../../src/transport';
import type { DataChannelMessage, TerminalDataMessage } from '@remote/shared';

/**
 * Layer 3: the whole week in one file — a Rust agent, a TypeScript offerer, a
 * real Worker, and real PTY bytes over a real DTLS/SCTP connection.
 *
 * Linux-only. The Rust binary is built for the host, the Worker binds a local
 * port, and `iceServers: []` means loopback host candidates must be enough. On
 * any other platform the suite is SKIPPED, not failed (spec §7.3).
 */
const isLinux = process.platform === 'linux';

/**
 * `import.meta.dirname` is Node >= 20.11 and typed by `@types/node` 24.13.6
 * (`module.d.ts`), which is what `tsc --noEmit` uses here. `__dirname` also
 * resolves at runtime under vitest 5 (both were checked), but the file is ESM
 * and this is the form that does not depend on the transform injecting a CJS
 * shim.
 */
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const AGENT_BIN = join(
  REPO_ROOT,
  'apps',
  'agent',
  'target',
  'debug',
  process.platform === 'win32' ? 'remote-agent.exe' : 'remote-agent',
);
const SIGNALING_DIR = join(REPO_ROOT, 'workers', 'signaling');
const PORT = 8787;

/**
 * `127.0.0.1`, not `localhost`. `wrangler dev` binds loopback IPv4 and prints
 * `Ready on http://127.0.0.1:8787`; on a host where `localhost` resolves to
 * `::1` first, the name-based URL costs a failed connect attempt per request.
 */
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/ws/agent`;

/** Bounded wait for the Worker to answer `GET /health`. */
async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(
    `wrangler dev did not answer GET /health within ${timeoutMs}ms (last: ${lastError})` +
      `\n--- wrangler output ---\n${wranglerOutput()}`,
  );
}

/**
 * Spawn a child and buffer its output.
 *
 * `stdin` is `'ignore'` on purpose, and that is load-bearing for the migration
 * child: `wrangler d1 migrations apply` prompts "About to apply N migration(s)
 * … continue?" and only skips the prompt when stdin is not a terminal. An
 * ignored stdin makes it non-interactive, so the prompt auto-confirms. A piped
 * stdin that is never written would hang the harness.
 *
 * Both output streams are buffered rather than inherited: a failing test must
 * be able to print why the child died, and inheriting would interleave it with
 * the reporter.
 */
function spawnLogged(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): { child: ChildProcess; output: () => string } {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32' && command === 'pnpm',
  });
  const chunks: string[] = [];
  child.stdout?.on('data', (c: Buffer) => chunks.push(c.toString()));
  child.stderr?.on('data', (c: Buffer) => chunks.push(c.toString()));
  return { child, output: () => chunks.join('') };
}

/** Kill a child and wait for it to actually exit, so no process leaks. */
async function killAndWait(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolvePromise) => {
    child.once('exit', () => resolvePromise());
    // A child that exited between the guard above and this listener would
    // otherwise leave the promise pending forever — turning a passing test into
    // a hung run.
    if (child.exitCode !== null || child.signalCode !== null) resolvePromise();
  });
}

let wrangler: ChildProcess | null = null;
let wranglerOutput: () => string = () => '';
let tempDir = '';

/**
 * Every agent process this file starts, killed in `afterAll`.
 *
 * A test-local `finally` would be the tighter scope, but the agents outlive
 * their test's assertions by design (the PTY keeps running until the socket
 * closes), and a list here means a test that throws before its `finally` is
 * still cleaned up.
 */
const agents: Array<{ child: ChildProcess; output: () => string }> = [];

/** The shape `POST /api/agents` returns after Task 3 (deviation D-11). */
interface AgentCreated {
  agent: { id: string; isOnline: boolean };
  credential: string;
}

async function postJson<T>(
  path: string,
  body: unknown,
  token?: string,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} -> HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

describe.skipIf(!isLinux)('cross-language terminal E2E', () => {
  beforeAll(async () => {
    // 1. A private persistence dir, so the harness never reads or writes the
    //    developer's own `.wrangler/state` and two runs cannot collide.
    //    `--persist-to` is resolved with `path.resolve(cwd, persistTo)`, so an
    //    absolute path is what makes this independent of where vitest ran.
    tempDir = mkdtempSync(join(tmpdir(), 'ponta-e2e-'));

    // 2. Migrate the SAME sqlite file `wrangler dev` will read. `wrangler dev`
    //    does not apply migrations, and both commands resolve their persistence
    //    path through the same helper, so passing the identical `--persist-to`
    //    to each is what keeps them pointed at one file.
    const migrate = spawnLogged(
      'pnpm',
      [
        'exec',
        'wrangler',
        'd1',
        'migrations',
        'apply',
        'remote-access',
        '--local',
        '--persist-to',
        tempDir,
      ],
      { cwd: SIGNALING_DIR },
    );
    const migrateExit = await new Promise<number | null>((r) =>
      migrate.child.once('exit', r),
    );
    if (migrateExit !== 0) {
      throw new Error(
        `migrations apply exited ${migrateExit}:\n${migrate.output()}`,
      );
    }

    // 3. Start the Worker on a fixed port. A fixed port rather than a probed
    //    free one, because Task 6's `AGENT_SERVER` default and the harness's
    //    `--server` flag have to agree on the same number.
    const dev = spawnLogged(
      'pnpm',
      [
        'exec',
        'wrangler',
        'dev',
        '--local',
        '--port',
        String(PORT),
        '--persist-to',
        tempDir,
      ],
      { cwd: SIGNALING_DIR },
    );
    wrangler = dev.child;
    wranglerOutput = dev.output;

    // Readiness is polled rather than read from the log. `wrangler dev` does
    // print `[wrangler:info] Ready on http://127.0.0.1:8787`, but that line's
    // format is wrangler's to change and it says the HTTP listener is up, not
    // that the Worker's routes answer. A 200 from `/health` says both.
    await waitForHealth();
  }, 120_000);

  afterAll(async () => {
    // Order matters: the agents first, so their socket closes do not race the
    // Worker's shutdown, then the Worker, then the temp dir.
    for (const entry of agents) {
      await killAndWait(entry.child);
    }
    agents.length = 0;
    await killAndWait(wrangler);
    wrangler = null;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  }, 60_000);

  /** Register a user, an agent and a session; return everything a test needs. */
  async function seed(): Promise<{
    token: string;
    agentId: string;
    credential: string;
    sessionId: string;
  }> {
    // A unique suffix, not a fixed name: the local D1 file is not wiped between
    // runs and `users.username` is UNIQUE, so a constant name makes the second
    // `pnpm test:e2e` fail with `USERNAME_EXISTS`. Readable prefix included so a
    // failed run is diagnosable.
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const auth = await postJson<{ token: string }>('/api/auth/register', {
      username: `e2e_${suffix}`,
      password: 'Password123!',
      publicKey: `pk_e2e_${suffix}`,
    });

    // `capabilities: ['terminal']` is what the agent's offer later has to match
    // (Task 6 refuses an offer that does not name `terminal`).
    const create = await postJson<AgentCreated>(
      '/api/agents',
      {
        id: `agent_e2e_${suffix}`,
        publicKey: `pk_agent_${suffix}`,
        capabilities: ['terminal'],
      },
      auth.token,
    );

    const session = await postJson<{ id: string }>(
      '/api/sessions',
      { agentId: create.agent.id },
      auth.token,
    );

    return {
      token: auth.token,
      agentId: create.agent.id,
      credential: create.credential,
      sessionId: session.id,
    };
  }

  /** Spawn the real binary (Task 6) and register it for teardown. */
  function spawnAgent(agentId: string, credential: string): void {
    const spawned = spawnLogged(
      AGENT_BIN,
      [
        '--agent-id',
        agentId,
        // The full route path (D-12). `--stun ''` disables ICE servers so the
        // only candidates are loopback host candidates — the harness must not
        // reach the network beyond 127.0.0.1, and Task 6's default is a public
        // STUN server.
        '--server',
        WS_URL,
        '--credential',
        credential,
        '--stun',
        '',
      ],
      { cwd: REPO_ROOT, env: { RUST_LOG: 'info' } },
    );
    agents.push(spawned);
  }

  /** Poll `GET /api/agents` until the agent's socket has registered. */
  async function waitForAgentOnline(
    token: string,
    agentId: string,
    timeoutMs = 20_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastSeen = 'never fetched';
    while (Date.now() < deadline) {
      const res = await fetch(`${BASE_URL}/api/agents`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const list = (await res.json()) as Array<{
          id: string;
          isOnline: boolean;
        }>;
        const found = list.find((a) => a.id === agentId);
        lastSeen = found ? `isOnline=${found.isOnline}` : 'agent absent';
        if (found?.isOnline) return;
      }
      await delay(250);
    }
    const output = agents.map((a) => a.output()).join('\n');
    throw new Error(
      `agent ${agentId} never reported online (${lastSeen}).\n` +
        `--- agent output ---\n${output}`,
    );
  }

  /**
   * Connect an offerer and wait for the `terminal` channel.
   *
   * The timeout is passed explicitly: `waitForChannel`'s default is 10000 ms
   * (`connection.ts:93`), and a real DTLS handshake against a binary that has
   * just started is worth more than that on a loaded CI runner.
   */
  async function connectTerminal(
    sessionId: string,
    token: string,
  ): Promise<{
    offerer: PeerConnection;
    frames: Array<DataChannelMessage<TerminalDataMessage>>;
  }> {
    const offerer = new PeerConnection(
      new WeriftAdapter({ iceServers: [] }),
      new RESTPollingTransport({ baseUrl: BASE_URL, sessionId, token }),
      { role: 'offerer', channelLabels: ['terminal'] },
    );

    // The listener is attached BEFORE `start()`, so a frame that arrives while
    // the channel is still opening has somewhere to go.
    const frames: Array<DataChannelMessage<TerminalDataMessage>> = [];
    offerer.dataChannels.onMessage<TerminalDataMessage>('terminal', (msg) => {
      frames.push(msg);
    });

    try {
      await offerer.start();
      const channel = await offerer.waitForChannel('terminal', 20_000);
      expect(channel.readyState).toBe('open');

      return { offerer, frames };
    } catch (err) {
      const agentLogs = agents
        .map((a, i) => `=== AGENT #${i} ===\n${a.output()}`)
        .join('\n');
      const wranglerLogs = wranglerOutput();
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n` +
          `--- AGENT LOGS ---\n${agentLogs}\n` +
          `--- WRANGLER LOGS ---\n${wranglerLogs}`,
      );
    }
  }

  /** Decode a frame's `payload.data` back to raw bytes. */
  function frameBytes(frame: DataChannelMessage<TerminalDataMessage>): Buffer {
    return Buffer.from(frame.payload.data, 'base64');
  }

  /** Send one `terminal-data` frame carrying `text` as UTF-8. */
  function sendKeystrokes(
    offerer: PeerConnection,
    sessionId: string,
    text: string,
  ): void {
    offerer.dataChannels.sendJson<TerminalDataMessage>(
      'terminal',
      'terminal-data',
      {
        terminalId: sessionId,
        data: Buffer.from(text, 'utf8').toString('base64'),
      },
    );
  }

  it('runs real PTY output over a real DTLS/SCTP connection', async () => {
    const { token, agentId, credential, sessionId } = await seed();

    spawnAgent(agentId, credential);

    // Ordered, not raced (spec §7.3 step 5): the offer must not be posted until
    // the socket is registered, or the push lands on an empty map and the
    // agent never sees it.
    await waitForAgentOnline(token, agentId);

    const { offerer, frames } = await connectTerminal(sessionId, token);

    try {
      // `sh` echoes the command back and then runs it, so "hello" appears in
      // the output either way; both arrive as separate frames.
      sendKeystrokes(offerer, sessionId, 'echo hello\n');

      const deadline = Date.now() + 20_000;
      let decoded = '';
      while (Date.now() < deadline) {
        decoded = frames.map((f) => frameBytes(f).toString('utf8')).join('');
        if (decoded.includes('hello')) break;
        await delay(100);
      }

      expect(
        decoded,
        `no "hello" in PTY output after 20s (${frames.length} frames)\n` +
          `--- decoded ---\n${JSON.stringify(decoded)}\n` +
          `--- agent output ---\n${agents.map((a) => a.output()).join('\n')}`,
      ).toContain('hello');

      // The envelope is the contract, not the JavaScript type of the raw
      // message. Week 4's 5b8ed86 proved that wrapping a string in a Buffer
      // silently downgrades a frame to WEBRTC_BINARY, so asserting on `typeof`
      // would pin an accident. These assertions come AFTER the byte assertion
      // on purpose: a failure should name the missing byte before it names a
      // shape mismatch, and with zero frames `frames[0]` would be undefined.
      expect(frames.length).toBeGreaterThan(0);
      const first = frames[0];
      expect(first).toBeDefined();
      expect(first?.channel).toBe('terminal');
      expect(first?.type).toBe('terminal-data');
      expect(typeof first?.payload.data).toBe('string');
      expect(first?.payload.terminalId).toBe(sessionId);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  // Review Focus #5, the second half: Task 6's Rust test proves the framing
  // round-trips 0xFF inside one process; this proves no layer between two
  // languages — Rust base64, the DTLS/SCTP data channel, the werift adapter,
  // the JS decode — turns it into U+FFFD.
  it('preserves a non-UTF-8 byte (0xFF) end to end', async () => {
    const { token, agentId, credential, sessionId } = await seed();

    spawnAgent(agentId, credential);
    await waitForAgentOnline(token, agentId);

    const { offerer, frames } = await connectTerminal(sessionId, token);

    try {
      // `printf '\377'` is the POSIX way to emit the single byte 0xFF with no
      // trailing newline; `\377` is octal for 255.
      sendKeystrokes(offerer, sessionId, "printf '\\377'\n");

      // The shell echoes the command line back, so the FIRST frame is the
      // literal text `printf '\377'` — which contains no 0xFF. The byte arrives
      // in a later frame as the command's own output. Scan every frame's bytes
      // rather than the concatenated string: a lossy UTF-8 conversion anywhere
      // in the chain turns 0xFF into U+FFFD, and concatenating first would hide
      // that behind a valid-looking string.
      const deadline = Date.now() + 20_000;
      let sawFF = false;
      while (Date.now() < deadline && !sawFF) {
        sawFF = frames.some((f) => frameBytes(f).includes(0xff));
        if (!sawFF) await delay(100);
      }

      expect(
        sawFF,
        `no 0xFF byte in any of ${frames.length} frames\n` +
          `--- frames (hex) ---\n` +
          frames.map((f) => frameBytes(f).toString('hex')).join('\n') +
          `\n--- agent output ---\n${agents.map((a) => a.output()).join('\n')}`,
      ).toBe(true);
    } finally {
      await offerer.close();
    }
  }, 90_000);
});

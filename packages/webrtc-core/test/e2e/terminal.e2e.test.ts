import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PeerConnection } from '../../src/connection';
import { WeriftAdapter } from '../../src/adapters/werift';
import { RESTPollingTransport } from '../../src/transport';
import type {
  DataChannelMessage,
  TerminalCreateMessage,
  TerminalDataMessage,
  TerminalResizeMessage,
} from '@ponter/shared';

/**
 * Layer 3: the whole week in one file — a Rust agent, a TypeScript offerer, the
 * real `@ponter/server` backend, and real PTY bytes over a real DTLS/SCTP
 * connection.
 *
 * Linux-only. The Rust binary is built for the host, the Node server binds a
 * local port, and `iceServers: []` means loopback host candidates must be
 * enough. On any other platform the suite is SKIPPED, not failed (spec §7.3).
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
  process.platform === 'win32' ? 'ponter-agent.exe' : 'ponter-agent',
);
const SERVER_DIR = join(REPO_ROOT, 'apps', 'server');
const PORT = 8787;

/**
 * `127.0.0.1`, not `localhost`: the harness binds loopback IPv4, and on a host
 * where `localhost` resolves to `::1` first the name-based URL costs a failed
 * connect attempt per request.
 */
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/ws/agent`;

/**
 * Fixed secrets, so the server child and the assertions agree and a failure is
 * reproducible. Both are >= 32 characters because `@ponter/server` treats an
 * unset secret as a hard startup error and the tests it ships with use this
 * same shape.
 */
const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

/** Bounded wait for the server to answer `GET /health`. */
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
    `@ponter/server did not answer GET /health within ${timeoutMs}ms (last: ${lastError})` +
      `\n--- server output ---\n${serverOutput()}`,
  );
}

/**
 * Spawn a child and buffer its output.
 *
 * `stdin` is `'ignore'` on purpose: neither the server nor an agent reads it,
 * and a piped stdin that is never written would hang the harness.
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
    detached: process.platform !== 'win32',
  });
  const chunks: string[] = [];
  child.stdout?.on('data', (c: Buffer) => chunks.push(c.toString()));
  child.stderr?.on('data', (c: Buffer) => chunks.push(c.toString()));
  return { child, output: () => chunks.join('') };
}

/** Kill a child and wait for it to actually exit, so no process leaks. */
async function killAndWait(child: ChildProcess | null): Promise<void> {
  if (!child) return;
  const pid = child.pid;
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // ignore if process group already dead
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise<void>((resolvePromise) => {
      child.once('exit', () => resolvePromise());
      // A child that exited between the guard above and this listener would
      // otherwise leave the promise pending forever — turning a passing test into
      // a hung run.
      if (child.exitCode !== null || child.signalCode !== null)
        resolvePromise();
    });
  }
}

let server: ChildProcess | null = null;
let serverOutput: () => string = () => '';
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

/** The shape `POST /api/agents` returns. */
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
    // 1. A private directory for the SQLite file, so the harness never reads or
    //    writes a developer's own database and two runs cannot collide. The
    //    server runs its `CREATE TABLE IF NOT EXISTS` migrations inline on the
    //    first `getDb()`, so there is no separate migrate step.
    tempDir = mkdtempSync(join(tmpdir(), 'ponter-e2e-'));

    // 2. Start the real Node server on a fixed port. A fixed port rather than a
    //    probed free one, because the harness's `--server` flag has to name the
    //    same number.
    //
    //    `tsx` transpiles the TypeScript entrypoint directly (the server ships
    //    `tsx` as a devDependency for exactly this). It is spawned through
    //    `pnpm exec` from `apps/server` so the workspace-local `tsx` resolves
    //    without a hoisted global install.
    const dev = spawnLogged('pnpm', ['exec', 'tsx', 'src/index.ts'], {
      cwd: SERVER_DIR,
      env: {
        PORT: String(PORT),
        DATABASE_PATH: join(tempDir, 'ponter-e2e.sqlite'),
        JWT_SECRET,
        REFRESH_TOKEN_SECRET,
        // No TURN: the ICE server list is then a single public STUN entry. The
        // agent prefers that pushed list over its own `--stun`, and loopback
        // host candidates still connect through it on a LAN/CI runner.
        TURN_SECRET: '',
        TURN_URL: '',
      },
    });
    server = dev.child;
    serverOutput = dev.output;

    // Readiness is polled rather than read from the log, so a 200 from
    // `/health` proves both the listener and the routes are up.
    await waitForHealth();
  }, 120_000);

  afterAll(async () => {
    // Order matters: the agents first, so their socket closes do not race the
    // server's shutdown, then the server, then the temp dir.
    for (const entry of agents) {
      await killAndWait(entry.child);
    }
    agents.length = 0;
    await killAndWait(server);
    server = null;
    if (process.platform !== 'win32') {
      try {
        const { execSync } = await import('node:child_process');
        // A safety net for a `tsx` child that outlived its group kill: the port
        // is dedicated to this suite, so reaping whatever holds it is safe.
        execSync(`fuser -k -9 ${PORT}/tcp 2>/dev/null || true`);
      } catch {}
    }
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
    // A unique suffix, not a fixed name: the SQLite file is not wiped between
    // tests and `users.username` is UNIQUE, so a constant name makes the second
    // `seed()` fail with `USERNAME_EXISTS`. Readable prefix included so a
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
        // The full route path (D-12). `--stun ''` leaves the agent's own STUN
        // empty; the server still pushes its `ice-servers` frame, and the agent
        // prefers that list. Loopback host candidates are what connect here.
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
      const serverLogs = serverOutput();
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n` +
          `--- AGENT LOGS ---\n${agentLogs}\n` +
          `--- SERVER LOGS ---\n${serverLogs}`,
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
    terminalId: string,
    text: string,
  ): void {
    offerer.dataChannels.sendJson<TerminalDataMessage>(
      'terminal',
      'terminal-data',
      {
        terminalId,
        data: Buffer.from(text, 'utf8').toString('base64'),
      },
    );
  }

  /** Send a `terminal-create` frame to spawn a new PTY session on the agent. */
  function sendTerminalCreate(
    offerer: PeerConnection,
    terminalId: string,
    cols = 80,
    rows = 24,
    shell?: string,
  ): void {
    offerer.dataChannels.sendJson<TerminalCreateMessage>(
      'terminal',
      'terminal-create',
      {
        terminalId,
        cols,
        rows,
        ...(shell ? { shell } : {}),
      },
    );
  }

  /** Send a `terminal-resize` frame to change the PTY window size. */
  function sendTerminalResize(
    offerer: PeerConnection,
    terminalId: string,
    cols: number,
    rows: number,
  ): void {
    offerer.dataChannels.sendJson<TerminalResizeMessage>(
      'terminal',
      'terminal-resize',
      {
        terminalId,
        cols,
        rows,
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

  // Week 6 multiplexing: two distinct terminalId values on the same DataChannel
  // must produce independent PTY output, each routed back by terminalId. This is
  // the cross-language proof that PtyManager's keyed dispatch works over a real
  // DTLS/SCTP transport, not just in the Rust unit test.
  it('multiplexes two terminal sessions over one DataChannel', async () => {
    const { token, agentId, credential, sessionId } = await seed();

    spawnAgent(agentId, credential);
    await waitForAgentOnline(token, agentId);

    const { offerer, frames } = await connectTerminal(sessionId, token);

    // Two distinct terminal ids, each with a unique marker so we can verify
    // output isolation rather than mere presence.
    const terminalA = `term-a-${sessionId}`;
    const terminalB = `term-b-${sessionId}`;

    try {
      // Explicitly create both sessions so spawn-on-demand is not the path under
      // test. Each `terminal-create` is a distinct message with its own id.
      sendTerminalCreate(offerer, terminalA);
      sendTerminalCreate(offerer, terminalB);

      // Give the agent a moment to process the create frames and spawn the PTYs.
      await delay(500);

      // Send a unique echo to each terminal via terminal-data.
      sendKeystrokes(offerer, terminalA, 'echo MARKER-A-42\n');
      sendKeystrokes(offerer, terminalB, 'echo MARKER-B-99\n');

      // Collect output per terminalId, tracking which frames we've already seen
      // so interleaved frames from both sessions don't get reprocessed.
      const deadline = Date.now() + 20_000;
      const processed = new Set<number>();
      let foundA = false;
      let foundB = false;
      let decodedA = '';
      let decodedB = '';

      while (Date.now() < deadline && (!foundA || !foundB)) {
        for (let i = 0; i < frames.length; i++) {
          if (processed.has(i)) continue;
          processed.add(i);

          const frame = frames[i];
          if (!frame) continue;
          const bytes = frameBytes(frame);
          const text = bytes.toString('utf8');
          const tid = frame.payload.terminalId;

          if (tid === terminalA) {
            decodedA += text;
            if (decodedA.includes('MARKER-A-42')) foundA = true;
          } else if (tid === terminalB) {
            decodedB += text;
            if (decodedB.includes('MARKER-B-99')) foundB = true;
          }
        }

        if (!foundA || !foundB) await delay(100);
      }

      expect(
        foundA,
        `terminal ${terminalA} never produced its marker\n` +
          `--- decoded A ---\n${JSON.stringify(decodedA)}\n` +
          `--- agent output ---\n${agents.map((a) => a.output()).join('\n')}`,
      ).toBe(true);

      expect(
        foundB,
        `terminal ${terminalB} never produced its marker\n` +
          `--- decoded B ---\n${JSON.stringify(decodedB)}\n` +
          `--- agent output ---\n${agents.map((a) => a.output()).join('\n')}`,
      ).toBe(true);

      // Verify output isolation: neither terminal received the other's marker.
      expect(
        decodedA,
        'terminal A received terminal B output — multiplexing is leaking',
      ).not.toContain('MARKER-B');
      expect(
        decodedB,
        'terminal B received terminal A output — multiplexing is leaking',
      ).not.toContain('MARKER-A');

      // Every received output frame must carry a terminalId so the browser can
      // demultiplex — no orphaned frames without a routing key.
      const orphaned = frames.filter(
        (f) =>
          !f.payload.terminalId ||
          (f.payload.terminalId !== terminalA &&
            f.payload.terminalId !== terminalB),
      );
      expect(
        orphaned,
        `found output frames for unexpected terminal ids:\n` +
          orphaned.map((f) => JSON.stringify(f.payload.terminalId)).join(', '),
      ).toHaveLength(0);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  // Spec §6.3: terminal-resize must change the PTY window size. Verified by
  // running `stty size` in the shell, which prints "rows cols" from the PTY.
  it('applies terminal-resize and verifies via stty size', async () => {
    const { token, agentId, credential, sessionId } = await seed();

    spawnAgent(agentId, credential);
    await waitForAgentOnline(token, agentId);

    const { offerer, frames } = await connectTerminal(sessionId, token);

    try {
      sendTerminalCreate(offerer, sessionId, 80, 24);
      await delay(500);

      sendTerminalResize(offerer, sessionId, 120, 40);
      await delay(500);

      sendKeystrokes(offerer, sessionId, 'stty size\n');

      const deadline = Date.now() + 20_000;
      let decoded = '';
      while (Date.now() < deadline) {
        decoded = frames.map((f) => frameBytes(f).toString('utf8')).join('');
        if (decoded.includes('40 120')) break;
        await delay(100);
      }

      expect(
        decoded,
        `no "40 120" in PTY output after 20s (${frames.length} frames)\n` +
          `--- decoded ---\n${JSON.stringify(decoded)}\n` +
          `--- agent output ---\n${agents.map((a) => a.output()).join('\n')}`,
      ).toContain('40 120');
    } finally {
      await offerer.close();
    }
  }, 90_000);
});

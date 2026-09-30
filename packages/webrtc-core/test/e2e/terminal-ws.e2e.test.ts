import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PeerConnection } from '../../src/connection';
import { WeriftAdapter } from '../../src/adapters/werift';
import { WebSocketSignalTransport } from '../../src/transport';
import type {
  DataChannelMessage,
  SignalMessage,
  TerminalDataMessage,
} from '@ponter/shared';

/**
 * Layer 3, WebSocket signaling variant: the same real Rust agent, real
 * `@ponter/server` backend and real DTLS/SCTP terminal, but the browser side
 * mints a ws-ticket and pushes signals over `/api/ws/browser` instead of
 * polling `/api/signal/poll`.
 *
 * This is the only test that exercises the ticket endpoint, the upgrade path
 * and the browser socket against the real server binary/process — the unit
 * suites mock either the socket or the fetch layer. The three behaviours that
 * unit tests cannot prove are here: signals really flow over the socket,
 * `SESSION_TERMINATED` really arrives when the agent's process dies, and a
 * ticket survives nothing — a fresh one is minted per (re)connect.
 *
 * Linux-only, like the REST variant: the Rust binary is built for the host.
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

/**
 * Poll `condition` until it holds, or fail with `description`.
 *
 * Condition polling, not a fixed sleep: the handshake it guards against is
 * fast on an idle host and slow on a loaded one, and a fixed delay is either
 * flaky or needlessly slow.
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
}

/**
 * Poll `GET /api/signal/poll/:sessionId` until a signal of `type` appears.
 *
 * Used as an independent readiness probe: a signal that is visible here was
 * accepted by the server over whatever path sent it, so the caller does not
 * have to guess at a sleep.
 */
async function pollForSignal(
  sessionId: string,
  token: string,
  type: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitFor(
    async () => {
      const res = await fetch(`${BASE_URL}/api/signal/poll/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const body = (await res.json()) as {
        signals?: Array<{ type: string }>;
      };
      return (body.signals ?? []).some((s) => s.type === type);
    },
    `a "${type}" signal to be recorded`,
    timeoutMs,
  );
}

/**
 * Poll `GET /api/signal/poll/:sessionId` until an `ice-candidate` whose
 * `candidate` string equals `value` appears.
 *
 * The type-only `pollForSignal` is enough for a first probe, but a probe sent
 * on both sides of a restart must match its *value*: the pre-restart candidate
 * is still in the table (signals are never deleted), so a type-only wait after
 * the restart would be satisfied instantly by the old row and prove nothing
 * about the reconnected socket.
 */
async function pollForCandidate(
  sessionId: string,
  token: string,
  value: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitFor(
    async () => {
      const res = await fetch(`${BASE_URL}/api/signal/poll/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const body = (await res.json()) as {
        signals?: Array<{ type: string; payload?: { candidate?: string } }>;
      };
      return (body.signals ?? []).some(
        (s) => s.type === 'ice-candidate' && s.payload?.candidate === value,
      );
    },
    `an ice-candidate matching "${value}"`,
    timeoutMs,
  );
}

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

/** True while something is listening on `port` on loopback. */
async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.on('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.on('error', () => resolvePromise(false));
  });
}

/**
 * Wait until nothing is listening on `port`, reaping stragglers.
 *
 * The server is started through `pnpm exec tsx`, which re-groups the real
 * listener: `pnpm` is the process the harness spawned and signalled, while the
 * `tsx` CLI and the `node` process that binds the port sit in a *different*
 * process group. `killAndWait` therefore kills `pnpm` and leaves the listener
 * alive, and the restarted server dies with `EADDRINUSE` (observed:
 * `MainThread` still holding `:8787` after the group kill).
 *
 * So this waits for the port to actually free, and if it does not, reaps
 * whatever still holds it. The port is dedicated to this suite, so that is
 * safe. Without this, `delivers signals again after the server restarts` is
 * not a test of the transport at all.
 */
async function waitForPortFree(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return;
    await delay(100);
  }
  if (process.platform !== 'win32') {
    try {
      execSync(`fuser -k -9 ${port}/tcp 2>/dev/null || true`);
    } catch {
      // `fuser` may be absent; the caller's restart will then fail loudly.
    }
  }
  const reapDeadline = Date.now() + 5_000;
  while (Date.now() < reapDeadline) {
    if (!(await isPortOpen(port))) return;
    await delay(100);
  }
  throw new Error(`port ${port} still held ${timeoutMs}ms after killing the server`);
}

/**
 * Count the agent's "connected to the signaling server" lines.
 *
 * The Rust agent logs exactly one per successful (re)connect, so a count that
 * increased is the deterministic proof that a *new* socket registered. This is
 * the only reliable post-restart readiness gate: `GET /api/agents` cannot be
 * used because the SIGKILLed server left `isOnline = true` in SQLite, and
 * `isAgentOnline` trusts that stale row — so the poll returns before the
 * agent's replacement socket exists.
 */
function agentConnectCount(output: () => string): number {
  return (output().match(/connected to the signaling server/g) ?? []).length;
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
  /**
   * Start the real Node server on the fixed port and wait for `/health`.
   *
   * Factored out of `beforeAll` because the restart test stops this process
   * and needs to bring an identical one back on the same port with the same
   * database file.
   */
  async function startServerProcess(): Promise<void> {
    // `tsx` transpiles the TypeScript entrypoint directly (the server ships
    // `tsx` as a devDependency for exactly this). It is spawned through
    // `pnpm exec` from `apps/server` so the workspace-local `tsx` resolves
    // without a hoisted global install.
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
  }

  beforeAll(async () => {
    // A private directory for the SQLite file, so the harness never reads or
    // writes a developer's own database and two runs cannot collide. The
    // server runs its `CREATE TABLE IF NOT EXISTS` migrations inline on the
    // first `getDb()`, so there is no separate migrate step.
    tempDir = mkdtempSync(join(tmpdir(), 'ponter-e2e-'));

    // A fixed port rather than a probed free one, because the harness's
    // `--server` flag has to name the same number — and the restart test
    // reuses it.
    await startServerProcess();
  }, 120_000);

  afterAll(async () => {
    // Order matters: the transports first (so their sockets close before the
    // server dies and does not log them as dropped), then the agents, so their
    // socket closes do not race the server's shutdown, then the server, then
    // the temp dir.
    for (const transport of transports) {
      transport.close();
    }
    transports.length = 0;
    for (const entry of agents) {
      await killAndWait(entry.child);
    }
    agents.length = 0;
    await killAndWait(server);
    server = null;
    if (process.platform !== 'win32') {
      try {
        // A safety net for a `tsx` child that outlived its group kill (see
        // `waitForPortFree`): the port is dedicated to this suite, so reaping
        // whatever holds it is safe.
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

  /**
   * Spawn the real binary (Task 6), register it for teardown, and return its
   * handle.
   *
   * The handle is returned because a test that restarts the server must read
   * *its own* agent's output: `agents[0]` is the first agent this file spawned,
   * which belongs to an earlier test, and a reconnect gate that watches the
   * wrong process is worse than none.
   */
  function spawnAgent(
    agentId: string,
    credential: string,
  ): { child: ChildProcess; output: () => string } {
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
    return spawned;
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
   * Every transport this file creates, closed in `afterAll`.
   *
   * The ws transport owns a live socket; leaving one open would keep the
   * vitest process alive after the last assertion.
   */
  const transports: WebSocketSignalTransport[] = [];

  /**
   * A WS transport for `sessionId`, minting tickets from `token`.
   *
   * `maxRetries` is a parameter because the restart test must outlast the
   * server's own startup (tsx compile + listen + `/health`), which can exceed
   * the default 5-attempt ladder's ~5s of wall clock.
   */
  function wsTransport(
    sessionId: string,
    token: string,
    maxRetries = 5,
  ): WebSocketSignalTransport {
    const transport = new WebSocketSignalTransport({
      baseUrl: BASE_URL,
      sessionId,
      // The ticket endpoint authenticates with the access token, not a
      // credential: this is the browser path exactly as `terminal.ts` uses it.
      getToken: async () => token,
      reconnect: true,
      maxRetries,
    });
    transports.push(transport);
    return transport;
  }

  /**
   * Connect an offerer and wait for the `terminal` channel.
   *
   * The timeout is passed explicitly: `waitForChannel`'s default is 10000 ms
   * (`connection.ts:93`), and a real DTLS handshake against a binary that has
   * just started is worth more than that on a loaded CI runner.
   *
   * `existing` lets the restart test drive the *same* reconnected socket rather
   * than a fresh one: passing it in is what makes the handshake proof that the
   * surviving socket works, not that a new connection does.
   */
  async function connectTerminal(
    sessionId: string,
    token: string,
    existing?: WebSocketSignalTransport,
  ): Promise<{
    offerer: PeerConnection;
    frames: Array<DataChannelMessage<TerminalDataMessage>>;
    transport: WebSocketSignalTransport;
  }> {
    const transport = existing ?? wsTransport(sessionId, token);
    const offerer = new PeerConnection(
      new WeriftAdapter({ iceServers: [] }),
      transport,
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

      return { offerer, frames, transport };
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

  // The point of this file: signals really travel over /api/ws/browser. The
  // unit suite fakes the socket, so only this run proves the ticket endpoint,
  // the upgrade, the subscribe/replay handshake and the live push work against
  // the real server process.
  it('runs real PTY output with signaling over the browser WebSocket', async () => {
    const { token, agentId, credential, sessionId } = await seed();

    spawnAgent(agentId, credential);
    await waitForAgentOnline(token, agentId);

    const { offerer, frames } = await connectTerminal(sessionId, token);

    try {
      sendKeystrokes(offerer, sessionId, 'echo hello-ws\n');

      const deadline = Date.now() + 20_000;
      let decoded = '';
      while (Date.now() < deadline) {
        decoded = frames.map((f) => frameBytes(f).toString('utf8')).join('');
        if (decoded.includes('hello-ws')) break;
        await delay(100);
      }

      expect(
        decoded,
        `no "hello-ws" in PTY output after 20s (${frames.length} frames)\n` +
          `--- decoded ---\n${JSON.stringify(decoded)}\n` +
          `--- agent output ---\n${agents.map((a) => a.output()).join('\n')}`,
      ).toContain('hello-ws');
    } finally {
      await offerer.close();
    }
  }, 90_000);

  // The failure mode the REST transport cannot exercise: the ticket is
  // consumed at upgrade time, so every (re)connect mints a fresh one, and a
  // socket that outlived the server is useless. This is the browser signaling
  // socket's own reconnect, proven end to end: the server is stopped and
  // restarted under a live subscription, and a full handshake driven through
  // the *surviving* transport must still complete.
  //
  // Two gates, both honest, because the obvious ones lie:
  //  - The agent's readiness cannot come from `GET /api/agents`: the SIGKILLed
  //    server left `isOnline = true` in SQLite and `isAgentOnline` trusts that
  //    stale row, so the poll returns before the replacement socket exists. The
  //    agent's own "connected to the signaling server" log line (one per
  //    (re)connect) is the deterministic signal instead.
  //  - The browser socket's readiness cannot be a type-only signal poll: the
  //    pre-restart candidate is still in the table (signals are never deleted),
  //    so a `type === 'ice-candidate'` wait would be satisfied by the old row.
  //    The second candidate is matched by *value*.
  //
  // No session is started before the restart: an offer would start one that
  // survives the restart in-process, and the agent is a single-session
  // answerer (ADR-14), so it would refuse the post-restart offer with
  // `approved: false`. Candidates for an inactive session are dropped, so the
  // agent's one slot stays free for the real offer after the reconnect.
  //
  // The Rust agent's own reconnect loop (200ms->2s backoff) is exercised while
  // the server is down.
  it('reconnects its signaling socket and delivers signals after a server restart', async () => {
    const { token, agentId, credential, sessionId } = await seed();

    const agent = spawnAgent(agentId, credential);
    await waitForAgentOnline(token, agentId);

    // A generous ladder: the server is down for the whole
    // kill -> port-free -> tsx start -> /health cycle, which is several seconds
    // and can exceed the default five-attempt budget. With no fallback
    // configured, exhausting the budget stops reconnecting for good, so the
    // test must not under-provision it.
    const transport = wsTransport(sessionId, token, 20);
    const received: SignalMessage[] = [];
    transport.subscribe((msg) => received.push(msg));

    // Baseline probe: a candidate is recorded (so a value-matched poll proves
    // the ticket minted, the upgrade completed and the subscribe ack arrived),
    // but the idle agent drops it, so no session starts (ADR-14).
    const beforeCandidate = 'candidate:1 1 udp 1 127.0.0.1 1 typ host';
    await transport.send({
      type: 'ice-candidate',
      data: {
        sessionId,
        candidate: beforeCandidate,
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    });
    await pollForCandidate(sessionId, token, beforeCandidate);

    const connectsBefore = agentConnectCount(agent.output);
    expect(connectsBefore).toBeGreaterThan(0);

    // Stop and restart the server under the live subscription. The port wait is
    // not redundant: `pnpm exec tsx` re-groups the listener, so the group kill
    // can leave `node` holding :8787 and the restart would die with
    // EADDRINUSE — failing the test for a harness reason, not a transport one.
    await killAndWait(server);
    server = null;
    await waitForPortFree(PORT);
    await startServerProcess();

    // The agent reconnects by itself and re-registers with the same id.
    await waitFor(
      () => agentConnectCount(agent.output) > connectsBefore,
      'the agent to reconnect after the restart',
      30_000,
    );

    // The transport reconnects on its own too: a fresh ticket, a new socket, a
    // new `subscribe`. The second candidate — matched by value, so the
    // pre-restart row cannot satisfy the wait — proves the reconnected socket's
    // sends reach the server.
    const afterCandidate = 'candidate:1 1 udp 1 127.0.0.1 2 typ host';
    await transport.send({
      type: 'ice-candidate',
      data: {
        sessionId,
        candidate: afterCandidate,
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    });
    await pollForCandidate(sessionId, token, afterCandidate);

    // The real proof: a full offer/answer/ICE/DTLS handshake driven through the
    // surviving transport. `connectTerminal` reuses `transport`, so a channel
    // that opens is a channel negotiated over the *reconnected* socket — the
    // ticket, the upgrade, the subscribe, the offer, the answer and every
    // candidate all travelled after the restart.
    try {
      const { offerer, frames } = await connectTerminal(
        sessionId,
        token,
        transport,
      );
      try {
        sendKeystrokes(offerer, sessionId, 'echo after-restart\n');

        const deadline = Date.now() + 20_000;
        let decoded = '';
        while (Date.now() < deadline) {
          decoded = frames
            .map((f) => frameBytes(f).toString('utf8'))
            .join('');
          if (decoded.includes('after-restart')) break;
          await delay(100);
        }

        expect(
          decoded,
          `no "after-restart" in PTY output after 20s (${frames.length} frames)\n` +
            `--- decoded ---\n${JSON.stringify(decoded)}\n` +
            `--- agent output ---\n${agents.map((a) => a.output()).join('\n')}`,
        ).toContain('after-restart');
      } finally {
        await offerer.close();
      }
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n` +
          `--- RECEIVED ---\n${JSON.stringify(received.map((m) => m.type))}\n` +
          `--- AGENT LOGS ---\n` +
          `${agents.map((a, i) => `=== AGENT #${i} ===\n${a.output()}`).join('\n')}\n` +
          `--- SERVER LOGS ---\n${serverOutput()}`,
      );
    }

    transport.close();
  }, 120_000);

  // SESSION_TERMINATED is pushed on the browser socket when the session ends
  // through the API (DELETE /api/sessions/:id) while a tab is subscribed. This
  // is the end-to-end proof that the transport's error frame arrives without a
  // poll: the REST transport would only discover it on the next poll tick.
  it('receives SESSION_TERMINATED on the socket when the session is deleted', async () => {
    const { token, agentId, credential, sessionId } = await seed();

    spawnAgent(agentId, credential);
    await waitForAgentOnline(token, agentId);

    const transport = wsTransport(sessionId, token);
    const errors: string[] = [];
    transport.subscribe(() => {});
    transport.onServerError((code) => errors.push(code));

    // Readiness, not a sleep: the socket only sends a `signal` frame after the
    // server's `subscribed` ack (the transport gates sends on `awaitingAck`), so
    // finding the offer through the REST poll proves three things at once — the
    // ticket minted, the upgrade completed, and the subscription is `live`. A
    // DELETE before that would race the subscribe handshake and the push would
    // land on a connection with no subscription to deliver it to.
    await transport.send({
      type: 'offer',
      data: { sessionId, sdp: 'v=0-offer', capabilities: ['terminal'] },
    });
    await pollForSignal(sessionId, token, 'offer');

    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok).toBe(true);

    await waitFor(
      () => errors.includes('SESSION_TERMINATED'),
      'SESSION_TERMINATED frame',
    );

    transport.close();
  }, 60_000);
});

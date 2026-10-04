import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';
import { PeerConnection } from '../../src/connection';
import { WeriftAdapter } from '../../src/adapters/werift';
import { RESTPollingTransport } from '../../src/transport';
import type { SignalTransport } from '../../src/types';
import type {
  DataChannelMessage,
  TerminalCreateMessage,
  TerminalDataMessage,
  TerminalResizeMessage,
} from '@ponter/shared';

/**
 * Linux-only flag for E2E tests.
 */
export const isLinux = process.platform === 'linux';

/**
 * Root directory of the monorepo workspace.
 */
export const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/**
 * Path to the prebuilt Rust agent binary.
 */
export const AGENT_BIN = join(
  REPO_ROOT,
  'apps',
  'agent',
  'target',
  'debug',
  process.platform === 'win32' ? 'ponter-agent.exe' : 'ponter-agent',
);

export const SERVER_DIR = join(REPO_ROOT, 'apps', 'server');
export const PORT = 8787;

/**
 * Loopback URLs for HTTP and WebSocket endpoints.
 */
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const WS_URL = `ws://127.0.0.1:${PORT}/api/ws/agent`;

/**
 * Fixed test secrets (>= 32 chars).
 */
export const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
export const REFRESH_TOKEN_SECRET =
  'test-refresh-secret-at-least-32-characters';

/**
 * Spawn a child and buffer its output.
 */
export function spawnLogged(
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

/**
 * Kill a child and wait for it to actually exit, so no process leaks.
 */
export async function killAndWait(child: ChildProcess | null): Promise<void> {
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
      if (child.exitCode !== null || child.signalCode !== null)
        resolvePromise();
    });
  }
}

/**
 * True while something is listening on `port` on loopback.
 */
export async function isPortOpen(port: number): Promise<boolean> {
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
 * Poll `attempt` until it reports success or `timeoutMs` elapses.
 *
 * Written recursively rather than as a `while` loop: every call site retries
 * an async operation until it succeeds, which is the sequential case Sonar's
 * S9382 documents as safe but still flags when written as a loop.
 */
async function pollUntil(
  attempt: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const step = async (): Promise<boolean> => {
    if (await attempt()) return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
    return step();
  };
  return step();
}

/**
 * Wait until nothing is listening on `port`, reaping stragglers.
 */
export async function waitForPortFree(
  port: number,
  timeoutMs = 15_000,
): Promise<void> {
  if (await pollUntil(async () => !(await isPortOpen(port)), timeoutMs, 100)) {
    return;
  }
  if (process.platform !== 'win32') {
    try {
      execSync(`fuser -k -9 ${port}/tcp 2>/dev/null || true`);
    } catch {
      // fuser may be absent
    }
  }
  if (await pollUntil(async () => !(await isPortOpen(port)), 5_000, 100)) {
    return;
  }
  throw new Error(
    `port ${port} still held ${timeoutMs}ms after killing the server`,
  );
}

/**
 * Count the agent's "connected to the signaling server" lines.
 */
export function agentConnectCount(output: () => string): number {
  return (output().match(/connected to the signaling server/g) ?? []).length;
}

/**
 * Poll `condition` until it holds, or fail with `description`.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  if (!(await pollUntil(condition, timeoutMs, 50))) {
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${description}`,
    );
  }
}

/**
 * Fetch the session's recorded signals, or `null` when the poll fails.
 */
async function pollSignals(
  sessionId: string,
  token: string,
): Promise<Array<{ type: string; payload?: { candidate?: string } }> | null> {
  const res = await fetch(`${BASE_URL}/api/signal/poll/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    signals?: Array<{ type: string; payload?: { candidate?: string } }>;
  };
  return body.signals ?? [];
}

/**
 * Poll `GET /api/signal/poll/:sessionId` until a signal of `type` appears.
 */
export async function pollForSignal(
  sessionId: string,
  token: string,
  type: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitFor(
    async () => {
      const signals = await pollSignals(sessionId, token);
      return signals !== null && signals.some((s) => s.type === type);
    },
    `a "${type}" signal to be recorded`,
    timeoutMs,
  );
}

/**
 * Poll `GET /api/signal/poll/:sessionId` until an `ice-candidate` whose
 * `candidate` string equals `value` appears.
 */
export async function pollForCandidate(
  sessionId: string,
  token: string,
  value: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitFor(
    async () => {
      const signals = await pollSignals(sessionId, token);
      return (
        signals !== null &&
        signals.some(
          (s) => s.type === 'ice-candidate' && s.payload?.candidate === value,
        )
      );
    },
    `an ice-candidate matching "${value}"`,
    timeoutMs,
  );
}

let currentServer: ChildProcess | null = null;
let currentServerOutput: () => string = () => '';
let currentTempDir = '';

/** Returns buffered server stdout and stderr. */
export function serverOutput(): string {
  return currentServerOutput();
}

/** Bounded wait for the server to answer `GET /health`. */
export async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  let lastError = 'no attempt made';
  const answered = await pollUntil(
    async () => {
      try {
        const res = await fetch(`${BASE_URL}/health`);
        if (res.ok) return true;
        lastError = `HTTP ${res.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      return false;
    },
    timeoutMs,
    250,
  );
  if (!answered) {
    throw new Error(
      `@ponter/server did not answer GET /health within ${timeoutMs}ms (last: ${lastError})` +
        `\n--- server output ---\n${serverOutput()}`,
    );
  }
}

/**
 * Start the real Node server on the fixed port and wait for `/health`.
 */
export async function startServerProcess(): Promise<void> {
  const dev = spawnLogged('pnpm', ['exec', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      PORT: String(PORT),
      DATABASE_PATH: join(currentTempDir, 'ponter-e2e.sqlite'),
      JWT_SECRET,
      REFRESH_TOKEN_SECRET,
      TURN_SECRET: '',
      TURN_URL: '',
      // TEST-ONLY escape hatch: the admin-approval gate makes non-first
      // registrants "pending" with no token, which breaks the E2E harness
      // (each test registers its own user). Enable auto-approve for E2E only;
      // the production default remains "pending manual approval".
      E2E_AUTO_APPROVE_USERS: 'true',
    },
  });
  currentServer = dev.child;
  currentServerOutput = dev.output;

  await waitForHealth();
}

/** Stop the running server child process. */
export async function stopServerProcess(): Promise<void> {
  await killAndWait(currentServer);
  currentServer = null;
}

/** Set up temp directory and start server for an E2E suite. */
export async function setupE2E(): Promise<void> {
  currentTempDir = mkdtempSync(join(tmpdir(), 'ponter-e2e-'));
  await startServerProcess();
}

/** Tear down server, all spawned agents, and clean up temp files and sockets. */
export async function teardownE2E(
  cleanup?: () => void | Promise<void>,
): Promise<void> {
  if (cleanup) {
    await cleanup();
  }
  // Independent processes: reap them concurrently rather than one per loop
  // iteration (S9382).
  await Promise.all(agents.map((entry) => killAndWait(entry.child)));
  agents.length = 0;
  await stopServerProcess();
  if (process.platform !== 'win32') {
    try {
      execSync(`fuser -k -9 ${PORT}/tcp 2>/dev/null || true`);
    } catch {}
  }
  if (currentTempDir) {
    rmSync(currentTempDir, { recursive: true, force: true });
    currentTempDir = '';
  }
}

/**
 * Every agent process started in the test session, killed in teardown.
 */
export const agents: Array<{ child: ChildProcess; output: () => string }> = [];

export interface AgentCreated {
  agent: { id: string; isOnline: boolean };
  credential: string;
}

export async function postJson<T>(
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

/** Register a user, an agent and a session; return everything a test needs. */
export async function seed({
  capabilities = ['terminal'],
}: { capabilities?: string[] } = {}): Promise<{
  token: string;
  agentId: string;
  credential: string;
  sessionId: string;
}> {
  // `randomUUID` rather than `Math.random`: S2245 flags any use of the
  // non-cryptographic PRNG, and a UUID is just as unique for a test suffix.
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  const auth = await postJson<{ token: string }>('/api/auth/register', {
    username: `e2e_${suffix}`,
    password: 'Password123!',
    publicKey: `pk_e2e_${suffix}`,
  });
  if (!auth?.token) {
    throw new Error(
      'register returned no token — is auto-approve enabled for E2E? (E2E_AUTO_APPROVE_USERS)',
    );
  }

  const create = await postJson<AgentCreated>(
    '/api/agents',
    {
      id: `agent_e2e_${suffix}`,
      publicKey: `pk_agent_${suffix}`,
      capabilities,
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

/** Spawn the real binary and register it for teardown. */
export function spawnAgent(
  agentId: string,
  credential: string,
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = {},
): { child: ChildProcess; output: () => string } {
  const spawned = spawnLogged(
    AGENT_BIN,
    [
      '--agent-id',
      agentId,
      '--server',
      WS_URL,
      '--credential',
      credential,
      '--stun',
      '',
      ...extraArgs,
    ],
    // The caller's env overrides the fixed default, so a test can raise the
    // log level (`{ RUST_LOG: 'debug' }`) to observe a `debug` line.
    { cwd: REPO_ROOT, env: { RUST_LOG: 'info', ...env } },
  );
  agents.push(spawned);
  return spawned;
}

/** Poll `GET /api/agents` until the agent's socket has registered. */
export async function waitForAgentOnline(
  token: string,
  agentId: string,
  timeoutMs = 20_000,
): Promise<void> {
  let lastSeen = 'never fetched';
  const online = await pollUntil(
    async () => {
      const res = await fetch(`${BASE_URL}/api/agents`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const list = (await res.json()) as Array<{
        id: string;
        isOnline: boolean;
      }>;
      const found = list.find((a) => a.id === agentId);
      lastSeen = found ? `isOnline=${found.isOnline}` : 'agent absent';
      return found?.isOnline === true;
    },
    timeoutMs,
    250,
  );
  if (!online) {
    const output = agents.map((a) => a.output()).join('\n');
    throw new Error(
      `agent ${agentId} never reported online (${lastSeen}).\n` +
        `--- agent output ---\n${output}`,
    );
  }
}

/** Decode a frame's `payload.data` back to raw bytes. */
export function frameBytes(
  frame: DataChannelMessage<TerminalDataMessage>,
): Buffer {
  return Buffer.from(frame.payload.data, 'base64');
}

/** Send one `terminal-data` frame carrying `text` as UTF-8. */
export function sendKeystrokes(
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
export function sendTerminalCreate(
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
export function sendTerminalResize(
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

/**
 * Create and start a PeerConnection with the 'terminal' channel,
 * buffering received frames.
 */
export async function openTerminalPeer(transport: SignalTransport): Promise<{
  offerer: PeerConnection;
  frames: Array<DataChannelMessage<TerminalDataMessage>>;
}> {
  const offerer = new PeerConnection(
    new WeriftAdapter({ iceServers: [] }),
    transport,
    { role: 'offerer', channelLabels: ['terminal'] },
  );

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

/** Connect an offerer with REST polling transport and wait for the `terminal` channel. */
export async function connectTerminal(
  sessionId: string,
  token: string,
): Promise<{
  offerer: PeerConnection;
  frames: Array<DataChannelMessage<TerminalDataMessage>>;
}> {
  return openTerminalPeer(
    new RESTPollingTransport({ baseUrl: BASE_URL, sessionId, token }),
  );
}

/**
 * Poll `frames` until their concatenated UTF-8 text contains `expected`,
 * and assert that it appears within `timeoutMs`.
 */
export async function waitForTerminalOutput(
  frames: Array<DataChannelMessage<TerminalDataMessage>>,
  expected: string,
  timeoutMs = 20_000,
): Promise<string> {
  const decode = (): string =>
    frames.map((f) => frameBytes(f).toString('utf8')).join('');
  let decoded = '';
  await pollUntil(
    () => {
      decoded = decode();
      return decoded.includes(expected);
    },
    timeoutMs,
    100,
  );

  expect(
    decoded,
    `no "${expected}" in PTY output after ${Math.round(timeoutMs / 1000)}s (${frames.length} frames)\n` +
      `--- decoded ---\n${JSON.stringify(decoded)}\n` +
      `--- agent output ---\n${agents.map((a) => a.output()).join('\n')}`,
  ).toContain(expected);

  return decoded;
}

/** A frame on the `files` channel, as received by the offerer. */
export type FilesFrame = DataChannelMessage<Record<string, unknown>>;

/**
 * Create and start a PeerConnection with the 'files' channel (spec §8.3),
 * buffering received frames. Mirrors `openTerminalPeer`.
 */
export async function openFilesPeer(transport: SignalTransport): Promise<{
  offerer: PeerConnection;
  frames: FilesFrame[];
}> {
  const offerer = new PeerConnection(
    new WeriftAdapter({ iceServers: [] }),
    transport,
    { role: 'offerer', channelLabels: ['files'], capabilities: ['files'] },
  );

  const frames: FilesFrame[] = [];
  offerer.dataChannels.onMessage<Record<string, unknown>>('files', (msg) => {
    frames.push(msg);
  });

  try {
    await offerer.start();
    const channel = await offerer.waitForChannel('files', 20_000);
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

/**
 * Poll `frames` until `predicate` matches one, and fail with `description`
 * (plus the last frames seen) after `timeoutMs`. The shared waiter keeps the
 * per-test polling blocks out of the suite (Sonar duplication budget).
 */
export async function waitForFilesFrame(
  frames: FilesFrame[],
  predicate: (frame: FilesFrame) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<FilesFrame> {
  let match: FilesFrame | undefined;
  const found = await pollUntil(
    () => {
      match = frames.find(predicate);
      return match !== undefined;
    },
    timeoutMs,
    50,
  );
  if (!found || !match) {
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${description}\n` +
        `--- frames seen ---\n${frames.map((f) => f.type).join('\n')}`,
    );
  }
  return match;
}

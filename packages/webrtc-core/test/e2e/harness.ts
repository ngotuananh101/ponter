import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';
import { PeerConnection } from '../../src/connection';
import { WeriftAdapter } from '../../src/adapters/werift';
import { RESTPollingTransport } from '../../src/transport';
import type { PeerConnectionIdentity, SignalTransport } from '../../src/types';
import { BINARY_HEADER_LEN, BINARY_TYPE_DOWNLOAD_CHUNK } from '@ponter/shared';
import type {
  DataChannelMessage,
  TerminalCreateMessage,
  TerminalDataMessage,
  TerminalResizeMessage,
} from '@ponter/shared';
import {
  generateSigningKeyPair,
  importSigningPublicKeyRaw,
  signProof,
  verifyProof,
} from '@ponter/crypto';

// Wire constants mirrored locally (Tasks 1-4 froze these). FILE_CHUNK_BYTES and
// WINDOW are NOT re-exported by @ponter/shared (only the binary frame type
// bytes and header length are), so they are defined here verbatim to match the
// agent's ADR-34/ADR-36 values rather than importing from the browser-oriented
// packages/file-core codec.
export const FILE_CHUNK_BYTES = 32768;
export const WINDOW = 64;

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

/** The signing keypair registered for the test user (WS2 peer identity). */
export interface UserSigningKey {
  /** Raw 32-byte Ed25519 public key, base64. Registered with the server. */
  publicKeyRawBase64: string;
  /** Non-extractable private key for signing offer proofs. */
  privateKey: CryptoKey;
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
  userSigning: UserSigningKey;
}> {
  // `randomUUID` rather than `Math.random`: S2245 flags any use of the
  // non-cryptographic PRNG, and a UUID is just as unique for a test suffix.
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  // WS2: generate a real Ed25519 signing keypair for the user so the offer
  // carries a verifiable peer identity proof. The public half is registered
  // alongside the legacy ECDH `publicKey`; the private half stays in-process
  // for signing offer proofs.
  const signingPair = await generateSigningKeyPair();

  const auth = await postJson<{ token: string }>('/api/auth/register', {
    username: `e2e_${suffix}`,
    password: 'Password123!',
    publicKey: `pk_e2e_${suffix}`,
    signingPublicKey: signingPair.publicKeyRawBase64,
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
    userSigning: {
      publicKeyRawBase64: signingPair.publicKeyRawBase64,
      privateKey: signingPair.privateKey,
    },
  };
}

/**
 * Spawn the real binary and register it for teardown.
 *
 * ALWAYS passes `--identity-path` pointing at a unique temp file so every test
 * agent gets its own Ed25519 keypair — never the shared host-persistent default
 * at `~/.config/ponter/agent-identity.pkcs8`. The path is derived from
 * `currentTempDir` (set by `setupE2E`) so it is cleaned in teardown.
 */
export function spawnAgent(
  agentId: string,
  credential: string,
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = {},
): { child: ChildProcess; output: () => string } {
  const identityPath = join(currentTempDir, `agent-identity-${agentId}.pkcs8`);
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
      '--identity-path',
      identityPath,
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

/**
 * The agent's WS2 signing public key, fetched from `GET /api/agents`.
 *
 * The server pushes the `identity-challenge` *and* sets `isOnline = true` in the
 * same connect handler, so `waitForAgentOnline` can observe `isOnline === true`
 * before the agent's `agent-identity` reply has landed and
 * `signingPublicKey` is still null. This helper polls until the key is set —
 * the browser needs it to build the `identity.verifyPeer` closure, and the
 * offer proof must be verified against the key the server actually holds.
 */
export async function waitForAgentSigningKey(
  token: string,
  agentId: string,
  timeoutMs = 20_000,
): Promise<string> {
  let lastSeen = 'never fetched';
  let publicKey: string | null = null;
  const ok = await pollUntil(
    async () => {
      const res = await fetch(`${BASE_URL}/api/agents`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const list = (await res.json()) as Array<{
        id: string;
        signingPublicKey: string | null;
      }>;
      const found = list.find((a) => a.id === agentId);
      if (found) {
        lastSeen = found.signingPublicKey
          ? 'signingPublicKey set'
          : 'signingPublicKey null';
        if (found.signingPublicKey) {
          publicKey = found.signingPublicKey;
          return true;
        }
      } else {
        lastSeen = 'agent absent';
      }
      return false;
    },
    timeoutMs,
    250,
  );
  if (!ok) {
    const output = agents.map((a) => a.output()).join('\n');
    throw new Error(
      `agent ${agentId} never published signingPublicKey (${lastSeen}).\n` +
        `--- agent output ---\n${output}`,
    );
  }
  return publicKey!;
}

/**
 * Build the `PeerConnectionOptions['identity']` object for an offerer.
 *
 * `sign` signs a canonical proof message with the user's Ed25519 private key;
 * `verifyPeer` checks the agent's answer-proof signature against the agent's
 * public key. Both use the `@ponter/crypto` helpers so the harness exercises
 * the same signing code the browser uses.
 */
export function buildPeerIdentity(
  userSigningPrivateKey: CryptoKey,
  userSigningPublicKeyBase64: string,
  agentSigningPublicKeyBase64: string,
): PeerConnectionIdentity {
  return {
    role: 'offerer',
    userSigningPublicKey: userSigningPublicKeyBase64,
    sign: (message: string) => signProof(userSigningPrivateKey, message),
    verifyPeer: async (
      message: string,
      signatureBase64: string,
    ): Promise<boolean> => {
      const agentPub = await importSigningPublicKeyRaw(
        agentSigningPublicKeyBase64,
      );
      return verifyProof(agentPub, message, signatureBase64);
    },
  };
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

/** Format an error from openTerminalPeer / openFilesPeer with current agent and server logs. */
function connectionFailure(err: unknown): string {
  const agentLogs = agents
    .map((a, i) => `=== AGENT #${i} ===\n${a.output()}`)
    .join('\n');
  const serverLogs = serverOutput();
  return (
    `${err instanceof Error ? err.message : String(err)}\n` +
    `--- AGENT LOGS ---\n${agentLogs}\n` +
    `--- SERVER LOGS ---\n${serverLogs}`
  );
}

/**
 * Create and start a PeerConnection with the 'terminal' channel,
 * buffering received frames.
 *
 * `sessionId` must be the REAL server-assigned session id (not 'test-session')
 * because `PeerConnection.start()` builds the offer proof's canonical message
 * from `options.sessionId`, and the agent verifies against the session the
 * server relayed. `identity` is optional for backward compatibility with tests
 * that intentionally exercise the no-proof path.
 */
export async function openTerminalPeer(
  transport: SignalTransport,
  sessionId: string,
  identity?: PeerConnectionIdentity,
): Promise<{
  offerer: PeerConnection;
  frames: Array<DataChannelMessage<TerminalDataMessage>>;
}> {
  const offerer = new PeerConnection(
    new WeriftAdapter({ iceServers: [] }),
    transport,
    {
      sessionId,
      role: 'offerer',
      channelLabels: ['terminal'],
      ...(identity ? { identity } : {}),
    },
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
    throw new Error(connectionFailure(err));
  }
}

/**
 * Connect an offerer with REST polling transport and wait for the `terminal`
 * channel. `identity` is optional: when omitted the offer carries no proof and
 * the agent must reject it (used by the negative identity test).
 */
export async function connectTerminal(
  sessionId: string,
  token: string,
  identity?: PeerConnectionIdentity,
): Promise<{
  offerer: PeerConnection;
  frames: Array<DataChannelMessage<TerminalDataMessage>>;
}> {
  const transport = new RESTPollingTransport({
    baseUrl: BASE_URL,
    sessionId,
    token,
  });
  return openTerminalPeer(transport, sessionId, identity);
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
 *
 * Captures BOTH typed JSON frames (via `onMessage`) and raw binary chunk
 * frames (via `onRawMessage`) into separate arrays. The typed listener fires
 * only for `string` payloads; binary chunk frames (ADR-36) arrive as
 * `ArrayBuffer` and are collected in `binaryFrames`.
 */
export async function openFilesPeer(
  transport: SignalTransport,
  sessionId: string,
  identity?: PeerConnectionIdentity,
): Promise<{
  offerer: PeerConnection;
  frames: FilesFrame[];
  binaryFrames: Uint8Array[];
}> {
  const offerer = new PeerConnection(
    new WeriftAdapter({ iceServers: [] }),
    transport,
    {
      sessionId,
      role: 'offerer',
      channelLabels: ['files'],
      capabilities: ['files'],
      ...(identity ? { identity } : {}),
    },
  );

  const frames: FilesFrame[] = [];
  offerer.dataChannels.onMessage<Record<string, unknown>>('files', (msg) => {
    frames.push(msg);
  });

  const binaryFrames: Uint8Array[] = [];
  offerer.dataChannels.onRawMessage('files', (data) => {
    // onRawMessage receives string | ArrayBuffer. Only ArrayBuffer payloads are
    // binary chunk frames (ADR-36); string payloads are JSON and already
    // delivered to the typed listener above.
    if (typeof data !== 'string') {
      binaryFrames.push(new Uint8Array(data as ArrayBuffer));
    }
  });

  try {
    await offerer.start();
    const channel = await offerer.waitForChannel('files', 20_000);
    expect(channel.readyState).toBe('open');

    return { offerer, frames, binaryFrames };
  } catch (err) {
    throw new Error(connectionFailure(err));
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

/**
 * Send a raw binary chunk frame over the `files` data channel. The caller is
 * responsible for packing the wire bytes (see `packBinary`); this helper is the
 * `sendRaw` seam the brief names.
 */
export function sendRaw(offerer: PeerConnection, bytes: Uint8Array): void {
  offerer.dataChannels.sendRaw('files', bytes);
}

/**
 * Pack a binary chunk frame per ADR-36:
 * `[1 byte type][16 byte transferId][8 byte BE chunkIndex][payload]`.
 *
 * `transferId` is a dashed RFC 4122 UUID string (like `crypto.randomUUID()`);
 * the dashes are stripped and the 32 hex chars are decoded to 16 raw bytes —
 * a local mirror of `packages/file-core/src/binary.ts`'s `uuidToBytes`, kept
 * inside the e2e dir so the suite does not import the browser-oriented codec.
 */
export function packBinary(
  type: number,
  transferId: string,
  chunkIndex: number,
  data: Uint8Array,
): Uint8Array {
  const hex = transferId.replaceAll('-', '');
  if (hex.length !== 32) {
    throw new Error('invalid uuid');
  }
  const out = new Uint8Array(BINARY_HEADER_LEN + data.byteLength);
  out[0] = type & 0xff;
  for (let i = 0; i < 16; i++) {
    out[i + 1] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  new DataView(out.buffer, out.byteOffset, out.byteLength).setBigUint64(
    17,
    BigInt(chunkIndex),
    false,
  );
  out.set(data, BINARY_HEADER_LEN);
  return out;
}

/**
 * Unpack an ADR-36 binary chunk frame: `[1 byte type][16 byte transferId]
 * [8 byte BE chunkIndex][payload]`.
 *
 * Throws if the frame is shorter than `BINARY_HEADER_LEN` (25 bytes). The 16
 * raw wire bytes are re-rendered as a dashed RFC 4122 UUID string — a local
 * mirror of `packages/file-core/src/binary.ts`'s `bytesToUuid`.
 */
export function unpackBinary(bytes: Uint8Array): {
  type: number;
  transferId: string;
  chunkIndex: number;
  data: Uint8Array;
} {
  if (bytes.byteLength < BINARY_HEADER_LEN) {
    throw new Error('binary frame truncated');
  }
  const type = bytes[0]!;
  let hex = '';
  for (let i = 0; i < 16; i++) {
    hex += bytes[i + 1]!.toString(16).padStart(2, '0');
  }
  const transferId =
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32);
  const chunkIndex = Number(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
      17,
      false,
    ),
  );
  const data = bytes.subarray(BINARY_HEADER_LEN);
  return { type, transferId, chunkIndex, data };
}

/**
 * Poll `binaryFrames` until `predicate` matches one, and fail with
 * `description` after `timeoutMs`. The binary twin of `waitForFilesFrame`.
 */
export async function waitForBinaryFrame(
  binaryFrames: Uint8Array[],
  predicate: (frame: Uint8Array) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<Uint8Array> {
  let match: Uint8Array | undefined;
  const found = await pollUntil(
    () => {
      match = binaryFrames.find(predicate);
      return match !== undefined;
    },
    timeoutMs,
    50,
  );
  if (!found || !match) {
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${description}\n` +
        `--- binary frames seen ---\n${binaryFrames.map((f) => f.byteLength).join('\n')}`,
    );
  }
  return match;
}

/** SHA-256 hex digest of a Buffer. */
export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Reassemble downloaded binary chunk frames (ADR-36 type 0x01) for a single
 * transfer into a contiguous Buffer, ordered by chunk index.
 */
export function assembleDownload(
  binaryFrames: Uint8Array[],
  transferId: string,
): Buffer {
  const chunks = new Map<number, Buffer>();
  for (const frame of binaryFrames) {
    const decoded = unpackBinary(frame);
    if (
      decoded.type === BINARY_TYPE_DOWNLOAD_CHUNK &&
      decoded.transferId === transferId
    ) {
      chunks.set(decoded.chunkIndex, Buffer.from(decoded.data));
    }
  }
  return Buffer.concat(
    [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b),
  );
}

/**
 * Decode a dashed RFC 4122 UUID string into 16 raw wire bytes.
 *
 * Local mirror of `packages/file-core/src/binary.ts`'s `uuidToBytes`, kept
 * inside the e2e dir so the suite does not import the browser-oriented codec.
 */
function uuidToRawBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll('-', '');
  if (hex.length !== 32) {
    throw new Error('invalid uuid');
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Process newly-seen binary frames starting at `cursor`, adding download
 * chunks that belong to `transferId` (as 16 raw bytes) into `chunks`.
 *
 * Avoids the full `unpackBinary` decode on every frame: a cheap length guard
 * and direct byte/index comparison on the 25-byte header suffice to identify
 * matching download-chunk frames and their chunk index.
 *
 * Returns the new cursor position so the caller can resume from the next
 * unseen frame on a subsequent pass.
 */
function processDownloadFrames(
  binaryFrames: Uint8Array[],
  cursor: number,
  transferIdBytes: Uint8Array,
  chunks: Set<number>,
): number {
  for (let i = cursor; i < binaryFrames.length; i++) {
    const frame = binaryFrames[i];
    if (!frame || frame.byteLength < BINARY_HEADER_LEN) continue;
    if (frame[0] !== BINARY_TYPE_DOWNLOAD_CHUNK) continue;

    // Compare the 16 transferId bytes at indices 1..16.
    let match = true;
    for (let j = 0; j < 16; j++) {
      if (frame[j + 1] !== transferIdBytes[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const chunkIndex = Number(view.getBigUint64(17, false));
    chunks.add(chunkIndex);
  }
  return binaryFrames.length;
}

/**
 * Count contiguous chunk indices present in `chunks`, starting the scan from
 * `startFrom` (typically the last acked frontier). Starting mid-scan avoids
 * re-scanning already-acked chunks — up to ~1.28M `Set.has` lookups on the
 * 50 MiB / 1600-chunk case when the old version restarted from 0 every poll.
 */
function calculateContiguousChunks(chunks: Set<number>, startFrom = 0): number {
  let contiguous = startFrom;
  while (chunks.has(contiguous)) contiguous++;
  return contiguous;
}

/**
 * Create a deferred promise with externally controlled resolve/reject functions.
 *
 * Returns a tuple of `[promise, resolve, reject]` so the resolve and reject
 * callbacks can be captured before the promise is awaited, avoiding the
 * "used before being assigned" TS2454 error that arises from assigning closures
 * inside a `new Promise((res, rej) => ...)` executor.
 */
function createDeferred<T>(): [
  Promise<T>,
  (value: T | PromiseLike<T>) => void,
  (reason?: unknown) => void,
] {
  let resolveFn!: (value: T | PromiseLike<T>) => void;
  let rejectFn!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return [promise, resolveFn, rejectFn];
}

/**
 * Drive a download to completion by acking contiguous chunk frontiers
 * (ADR-37), waiting until `totalChunks` distinct chunks have been observed.
 *
 * Instead of polling `binaryFrames` on a timer, this hooks the offerer's
 * `binaryFrames.push` seam so `processFrames()` runs synchronously the moment a
 * new binary chunk frame arrives. That keeps the agent's 64-chunk sliding
 * window continuously full without stalling the Rust agent's send loop.
 *
 * A `setTimeout` rejects the promise if `timeoutMs` elapses before `totalChunks`
 * distinct chunks are observed, and `cleanup` restores the original `push` on
 * resolution, rejection, or unexpected error.
 */
/** ACK batch threshold: emit a sendAck every 8 newly-acked chunks. */
const ACK_BATCH_CHUNKS = 8;

export async function drainDownload(
  binaryFrames: Uint8Array[],
  transferId: string,
  totalChunks: number,
  sendAck: (nextChunkIndex: number) => void,
  timeoutMs = 60_000,
): Promise<void> {
  const transferIdBytes = uuidToRawBytes(transferId);
  const chunks = new Set<number>();
  let cursor = 0;
  let lastAcked = 0;
  let settle = false;
  let flushPending = false;

  const origPush = binaryFrames.push;

  const [promise, resolveFn, rejectFn] = createDeferred<void>();

  const timer = setTimeout(() => {
    cleanup();
    if (chunks.size < totalChunks) {
      rejectFn(new Error(`drainDownload timed out after ${timeoutMs}ms`));
    }
  }, timeoutMs);

  const cleanup = () => {
    if (settle) return;
    settle = true;
    binaryFrames.push = origPush;
    flushPending = false;
    clearTimeout(timer);
  };

  const processFrames = () => {
    try {
      cursor = processDownloadFrames(
        binaryFrames,
        cursor,
        transferIdBytes,
        chunks,
      );
      const contiguous = calculateContiguousChunks(chunks, lastAcked);

      if (
        contiguous - lastAcked >= ACK_BATCH_CHUNKS ||
        contiguous >= totalChunks
      ) {
        lastAcked = contiguous;
        sendAck(contiguous);
      } else if (contiguous > lastAcked && !flushPending) {
        flushPending = true;
        queueMicrotask(() => {
          if (settle) return;
          try {
            const contiguousNow = calculateContiguousChunks(chunks, lastAcked);
            if (contiguousNow > lastAcked) {
              lastAcked = contiguousNow;
              sendAck(contiguousNow);
            }
          } catch (err) {
            cleanup();
            rejectFn(err);
          } finally {
            flushPending = false;
          }
        });
      }

      if (chunks.size >= totalChunks) {
        cleanup();
        resolveFn();
      }
    } catch (err) {
      cleanup();
      rejectFn(err);
    }
  };

  // Hook `binaryFrames.push` to process frames synchronously as they arrive.
  binaryFrames.push = function (...items: Uint8Array[]): number {
    origPush.apply(binaryFrames, items);
    processFrames();
    return binaryFrames.length;
  };

  // Process any frames that were already buffered before the hook was installed.
  processFrames();
  await promise;
  expect(chunks.size).toBe(totalChunks);
}

/**
 * Register + spawn an agent whose files gate is open on `rootDir`.
 *
 * Shared by files.e2e.test.ts and files-advanced.e2e.test.ts to eliminate the
 * duplicate local definition those suites previously carried (S9382/S7781
 * duplication budget — one source of truth for the files test harness).
 */
export async function connectFilesAgent(
  rootDir: string,
  baseUrl = BASE_URL,
): Promise<{
  token: string;
  agentId: string;
  sessionId: string;
  frames: FilesFrame[];
  binaryFrames: Uint8Array[];
  offerer: PeerConnection;
  send: (type: string, payload: unknown) => void;
  sendRawChunk: (
    type: number,
    transferId: string,
    chunkIndex: number,
    data: Uint8Array,
  ) => void;
}> {
  const { token, agentId, credential, sessionId, userSigning } = await seed({
    capabilities: ['files'],
  });
  spawnAgent(agentId, credential, ['--files-root', rootDir]);
  await waitForAgentOnline(token, agentId);
  const agentSigningPublicKey = await waitForAgentSigningKey(token, agentId);
  const identity = buildPeerIdentity(
    userSigning.privateKey,
    userSigning.publicKeyRawBase64,
    agentSigningPublicKey,
  );
  const { offerer, frames, binaryFrames } = await openFilesPeer(
    new RESTPollingTransport({ baseUrl, sessionId, token }),
    sessionId,
    identity,
  );
  return {
    token,
    agentId,
    sessionId,
    frames,
    binaryFrames,
    offerer,
    send: (type, payload) =>
      offerer.dataChannels.sendJson('files', type, payload),
    sendRawChunk: (type, transferId, chunkIndex, data) =>
      sendRaw(offerer, packBinary(type, transferId, chunkIndex, data)),
  };
}

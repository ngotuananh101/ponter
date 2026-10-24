// apps/agent/src/config.ts
import { STREAM_PROFILES, type StreamProfile } from '@ponter/shared';
import { existsSync } from 'node:fs';

export type AgentConfigErrorCode =
  'MISSING_CREDENTIAL' | 'UNKNOWN_PROFILE' | 'UNKNOWN_DESKTOP_SOURCE';

export class AgentConfigError extends Error {
  readonly code: AgentConfigErrorCode;
  constructor(code: AgentConfigErrorCode, message: string) {
    super(message);
    this.name = 'AgentConfigError';
    this.code = code;
  }
}

export interface AgentConfig {
  readonly agentId: string;
  readonly server: string;
  readonly credential: string;
  readonly shell: string;
  readonly identityPath: string;
  readonly stun: string;
  readonly cols: number;
  readonly rows: number;
  readonly allowInput: boolean;
  readonly filesRoot: string | null;
  readonly desktopProfile: StreamProfile;
  readonly desktopDefaultSource: string;
  /** `AGENT_DESKTOP_SOURCE` (`main.rs:64`): which frame source the agent captures. */
  readonly desktopSource: 'screen' | 'test';
  /** `AGENT_DESKTOP_SELECT_TIMEOUT_MS` (`main.rs:80`, ADR-22), default 5000. */
  readonly desktopSelectTimeoutMs: number;
  /** `AGENT_DESKTOP_POLL_INTERVAL_MS`; `null` means the profile's frame budget. */
  readonly desktopPollIntervalMs: number | null;
}

const DEFAULT_SERVER = 'ws://localhost:8787/api/ws/agent';
const DEFAULT_STUN = 'stun:stun.l.google.com:19302';
const DEFAULT_PROFILE = '1080p30';
const DEFAULT_SOURCE = 'primary';
const DEFAULT_DESKTOP_SOURCE = 'screen';
const DEFAULT_SELECT_TIMEOUT_MS = 5000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** The two capture backends the Rust's `DesktopSource` enum accepts (`lib.rs:427`). */
const DESKTOP_SOURCES = ['screen', 'test'] as const;

/** `1`/`true`/`yes` on, anything else off. Off is the default: the gate is opt-in. */
function envFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * A positive integer or `null` — the shape of an optional interval.
 *
 * The Rust treats an absent, empty, zero or unparseable value as "use the
 * fallback" (`desktop.rs:567-572`), and a zero interval is a busy loop, so `0`
 * is normalized to `null` here rather than surfacing as a spin.
 */
function envOptionalInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the agent's configuration from the environment only.
 *
 * There is no CLI: the desktop supervisor passes every value as an env var, and
 * a credential on argv would be visible in `ps` (ADR-13). Every fallback here is
 * a value the Rust CLI also defaulted to, so a deployment that sets nothing
 * behaves exactly as before.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): AgentConfig {
  const credential = env.AGENT_CREDENTIAL?.trim();
  if (!credential) {
    throw new AgentConfigError(
      'MISSING_CREDENTIAL',
      'no agent credential: set AGENT_CREDENTIAL (the value is ag_...)',
    );
  }

  const profileName = env.AGENT_DESKTOP_PROFILE?.trim() || DEFAULT_PROFILE;
  const desktopProfile = STREAM_PROFILES.find((p) => p.id === profileName);
  if (!desktopProfile) {
    const known = STREAM_PROFILES.map((p) => p.id).join(', ');
    throw new AgentConfigError(
      'UNKNOWN_PROFILE',
      `unknown desktop profile "${profileName}"; expected ${known}`,
    );
  }

  const configHome = env.XDG_CONFIG_HOME?.trim() || `${env.HOME ?? ''}/.config`;

  const rawSource = env.AGENT_DESKTOP_SOURCE?.trim() || DEFAULT_DESKTOP_SOURCE;
  if (!(DESKTOP_SOURCES as readonly string[]).includes(rawSource)) {
    throw new AgentConfigError(
      'UNKNOWN_DESKTOP_SOURCE',
      `unknown desktop source "${rawSource}"; expected ${DESKTOP_SOURCES.join(', ')}`,
    );
  }
  const desktopSource = rawSource as 'screen' | 'test';

  return Object.freeze({
    agentId: env.AGENT_ID?.trim() ?? '',
    server: env.AGENT_SERVER?.trim() || DEFAULT_SERVER,
    credential,
    shell: resolveShell(env, platform),
    identityPath:
      env.AGENT_IDENTITY_PATH?.trim() ||
      `${configHome}/ponter/agent-identity.pkcs8`,
    stun: env.STUN_SERVER ?? DEFAULT_STUN,
    // `--cols`/`--rows` are clap flags with no `env =` (`main.rs:56-60`) and the
    // supervisor never passes them, so these are constants, not env reads. The
    // PTY still needs an initial geometry and the renderer resizes it on attach.
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    allowInput: envFlag(env.AGENT_ALLOW_INPUT),
    filesRoot: env.AGENT_FILES_ROOT?.trim()
      ? env.AGENT_FILES_ROOT.trim()
      : null,
    desktopProfile,
    desktopDefaultSource:
      env.AGENT_DESKTOP_DEFAULT_SOURCE?.trim() || DEFAULT_SOURCE,
    desktopSource,
    desktopSelectTimeoutMs: envInt(
      env.AGENT_DESKTOP_SELECT_TIMEOUT_MS,
      DEFAULT_SELECT_TIMEOUT_MS,
    ),
    desktopPollIntervalMs: envOptionalInt(env.AGENT_DESKTOP_POLL_INTERVAL_MS),
  });
}

// --- operator shell resolution (B38) ---
// Ported from `main.rs:145-260`. This is a config-time concern, so it lives in
// `config.ts` rather than in the terminal package: the value it produces is a
// field of `AgentConfig`, and the shell *policy* that governs peer-requested
// shells is a different thing entirely (Task 9's `ShellPolicy`).

/** Windows shells in preference order (`main.rs:185`). */
export const WINDOWS_SHELL_PREFERENCE = [
  'pwsh',
  'powershell',
  'cmd.exe',
] as const;

/**
 * The first candidate `resolve` yields a value for, in order.
 *
 * Pure, so the ordering is testable without a real `PATH` or filesystem, and
 * generic over the resolved type so a caller can return an absolute path
 * rather than the bare name (`main.rs:169-182`).
 */
export function firstAvailable<T>(
  preference: readonly string[],
  resolve: (name: string) => T | undefined,
): T | undefined {
  for (const name of preference) {
    const resolved = resolve(name);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/**
 * Directories where a Windows shell may live without being on `PATH`.
 *
 * `pwsh` is the case that matters: the MSI installs to
 * `C:\Program Files\PowerShell\7\` and does not always add that directory to
 * `PATH`, so a `PATH`-only probe would miss PowerShell 7 and fall through to
 * the older `powershell.exe` (`main.rs:186-207`).
 */
export function windowsShellRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    'C:\\Program Files\\PowerShell\\7',
    'C:\\Program Files\\PowerShell\\7-preview',
  ];
  const programFiles = env.ProgramFiles?.trim();
  if (programFiles) {
    roots.push(
      `${programFiles}\\PowerShell\\7`,
      `${programFiles}\\PowerShell\\7-preview`,
    );
  }
  const programFilesX86 = env['ProgramFiles(x86)']?.trim();
  if (programFilesX86) {
    roots.push(`${programFilesX86}\\PowerShell\\7`);
  }
  roots.push('C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
  return roots;
}

/**
 * Resolve the operator's shell from the environment.
 *
 * `AGENT_SHELL` wins unconditionally — a pinned value must never be overridden
 * by detection, or existing deployments would silently change shell. Then
 * `$SHELL`, then the platform default. On Windows the default is the first
 * shell found in preference order, falling back to the bare `cmd.exe`, which
 * `CreateProcess` resolves to `%SystemRoot%\System32\cmd.exe` (`main.rs:155-176`).
 *
 * `probe` exists so the Windows path is unit-testable on any host; production
 * passes nothing and gets a real `PATH` + install-root probe.
 */
export function resolveShell(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  probe?: (name: string, roots: string[]) => string | undefined,
): string {
  const explicit = env.AGENT_SHELL?.trim();
  if (explicit) return explicit;

  if (platform !== 'win32') {
    return env.SHELL?.trim() || '/bin/sh';
  }

  const resolve = probe ?? resolveWindowsShell;
  const roots = windowsShellRoots(env);
  return (
    firstAvailable(WINDOWS_SHELL_PREFERENCE, (name) => resolve(name, roots)) ??
    'cmd.exe'
  );
}

/**
 * Locate one Windows shell, preferring a `PATH` hit and falling back to the
 * well-known install roots (`main.rs:213-260`).
 *
 * The result is always an absolute path so node-pty never has to guess, and it
 * is returned unmodified — this value is an executable, not a command line, so
 * there is no interpolation of user input here.
 */
function resolveWindowsShell(
  name: string,
  roots: string[],
): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (!dir) continue;
    for (const ext of ['.exe', '']) {
      const candidate = `${dir}\\${name}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const root of roots) {
    for (const ext of ['.exe', '']) {
      const candidate = `${root}\\${name}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

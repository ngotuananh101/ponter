import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * The four shells that exist on a stock POSIX host. The floor is not a
 * convenience: without it, a container with no `/etc/shells` would have an empty
 * allowlist and the terminal feature would be silently dead.
 */
export const UNIX_SHELL_FLOOR: readonly string[] = [
  '/bin/sh',
  '/bin/bash',
  '/usr/bin/sh',
  '/usr/bin/bash',
];

export class ShellRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellRefusedError';
  }
}

export interface ShellPolicyOptions {
  /** `AGENT_SHELL` / `$SHELL`. Always allowed — the operator chose it. */
  configured: string;
  /** Contents of `/etc/shells`, or '' when the file is absent or unreadable. */
  etcShells?: string;
}

function canonicalise(candidate: string): string | null {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function etcShellsEntries(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Which shells a peer is allowed to spawn (B36, B37 — B38 is the
 * operator's own shell, resolved at config time in `config.ts`).
 *
 * Two properties the Rust established and this keeps:
 *
 * - **Canonical on both sides of the comparison.** A symlink to an allowlisted
 *   shell is accepted; a symlink pointing anywhere else is refused. Comparing
 *   strings would accept `/tmp/evil -> /bin/sh` under a `/tmp/evil` entry and
 *   refuse the same shell through a legitimate link.
 * - **Order matters: executable bit before allowlist membership.** A 0644 file
 *   outside the allowlist fails as "not executable"; telling the user to edit
 *   the allowlist would not fix it.
 */
export class ShellPolicy {
  private readonly allowed: ReadonlySet<string>;

  constructor(options: ShellPolicyOptions) {
    const allowed = new Set<string>();
    for (const candidate of [
      options.configured,
      ...UNIX_SHELL_FLOOR,
      ...etcShellsEntries(options.etcShells ?? ''),
    ]) {
      const resolved = canonicalise(candidate);
      if (resolved) allowed.add(resolved);
    }
    this.allowed = allowed;
  }

  /**
   * Resolve a peer-requested shell, or throw with the reason.
   *
   * The messages are the Rust's, because they reach the browser as the
   * `terminal-error` detail and the web UI shows them verbatim.
   */
  resolveClientShell(requested: string): string {
    if (!isAbsolute(requested)) {
      throw new ShellRefusedError(`${requested} is not an absolute path`);
    }
    const resolved = canonicalise(requested);
    if (resolved === null) {
      throw new ShellRefusedError(`${requested} cannot be resolved`);
    }
    if (!statSync(resolved).isFile()) {
      throw new ShellRefusedError(`${requested} is not a file`);
    }
    try {
      accessSync(resolved, constants.X_OK);
    } catch {
      throw new ShellRefusedError(`${requested} is not executable`);
    }
    if (!this.allowed.has(resolved)) {
      throw new ShellRefusedError(`${requested} is not in the shell allowlist`);
    }
    return resolved;
  }
}

/**
 * Windows has no allowlist: the operator's configured shell is the only
 * candidate, and there is no `/etc/shells`. The PowerShell probe order
 * (`pwsh` → `powershell` → `cmd.exe`) is resolved at config time by
 * `resolveShell` in `config.ts` (Task 1), because it picks the *operator's*
 * shell, not a peer-requested one. This module's job is the POSIX policy,
 * which is a different question: which shells a *peer* may ask for.
 */
export function loadShellPolicy(options: ShellPolicyOptions): ShellPolicy {
  return new ShellPolicy(options);
}

/** Reads `/etc/shells`, treating every failure as "no extra entries". */
export function readEtcShells(): string {
  try {
    return readFileSync('/etc/shells', 'utf8');
  } catch {
    return '';
  }
}

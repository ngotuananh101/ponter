import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadShellPolicy } from '../../src/terminal/shell-policy.js';

/** Every temp dir this file creates, removed once the file finishes. */
const TMP_DIRS: string[] = [];
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

// `recursive` because the fixture nests directories; `force` so a cell that
// already removed its own path cannot fail the file from a teardown.
afterAll(() => {
  for (const dir of TMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = tmpDir('ponter-shell-');
  const allowed = join(dir, 'allowed.sh');
  writeFileSync(allowed, '#!/bin/sh\n');
  chmodSync(allowed, 0o755);
  return { dir, allowed };
}

describe('ShellPolicy.resolveClientShell', () => {
  it('resolves an allowlisted executable to its canonical path', () => {
    const { allowed } = scratch();
    const policy = loadShellPolicy({ configured: allowed });
    expect(policy.resolveClientShell(allowed)).toBe(allowed);
  });

  it('refuses a relative path', () => {
    const { allowed } = scratch();
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell('bin/sh')).toThrow(
      /is not an absolute path/,
    );
  });

  it('refuses a path that does not exist', () => {
    const { dir, allowed } = scratch();
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell(join(dir, 'missing'))).toThrow(
      /cannot be resolved/,
    );
  });

  it('refuses a directory', () => {
    const { dir, allowed } = scratch();
    const nested = join(dir, 'sub');
    mkdirSync(nested);
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell(nested)).toThrow(/is not a file/);
  });

  it('refuses a non-executable file', () => {
    const { allowed } = scratch();
    const plain = join(allowed, '..', 'plain.sh');
    writeFileSync(plain, '#!/bin/sh\n');
    chmodSync(plain, 0o644);
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell(plain)).toThrow(/is not executable/);
  });

  it('checks the executable bit BEFORE allowlist membership', () => {
    // A 0644 file that is also absent from the allowlist must fail as
    // "not executable": reporting "not in the allowlist" would send the user to
    // edit a config file that would not fix the problem.
    const { dir, allowed } = scratch();
    const plain = join(dir, 'plain.sh');
    writeFileSync(plain, '#!/bin/sh\n');
    chmodSync(plain, 0o644);
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell(plain)).toThrow(/is not executable/);
  });

  it('refuses an executable that is not in the allowlist', () => {
    const { dir, allowed } = scratch();
    const outside = join(dir, 'outside.sh');
    writeFileSync(outside, '#!/bin/sh\n');
    chmodSync(outside, 0o755);
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell(outside)).toThrow(
      /is not in the shell allowlist/,
    );
  });

  it('accepts a symlink that resolves to an allowlisted target', () => {
    const { dir, allowed } = scratch();
    const link = join(dir, 'link.sh');
    symlinkSync(allowed, link);
    const policy = loadShellPolicy({ configured: allowed });
    expect(policy.resolveClientShell(link)).toBe(allowed);
  });

  it('refuses a symlink that resolves outside the allowlist', () => {
    const { dir, allowed } = scratch();
    const target = join(dir, 'target.sh');
    writeFileSync(target, '#!/bin/sh\n');
    chmodSync(target, 0o755);
    const link = join(dir, 'link.sh');
    symlinkSync(target, link);
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell(link)).toThrow(
      /is not in the shell allowlist/,
    );
  });

  it('always allows the configured shell, even one outside the floor', () => {
    const { dir, allowed } = scratch();
    const custom = join(dir, 'custom.sh');
    writeFileSync(custom, '#!/bin/sh\n');
    chmodSync(custom, 0o755);
    const policy = loadShellPolicy({ configured: custom });
    expect(policy.resolveClientShell(custom)).toBe(custom);
    expect(() => policy.resolveClientShell(allowed)).toThrow(
      /is not in the shell allowlist/,
    );
  });

  it('allows entries listed in the supplied /etc/shells content', () => {
    const { dir } = scratch();
    const extra = join(dir, 'extra.sh');
    writeFileSync(extra, '#!/bin/sh\n');
    chmodSync(extra, 0o755);
    const policy = loadShellPolicy({
      configured: extra,
      etcShells: `# comment\n\n${extra}\n`,
    });
    expect(policy.resolveClientShell(extra)).toBe(extra);
  });

  it('treats a missing /etc/shells as an empty list rather than an error', () => {
    const { allowed } = scratch();
    expect(() =>
      loadShellPolicy({ configured: allowed, etcShells: '' }),
    ).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/**
 * Render electron-builder's FPM scriptlet macros to fixed test values, then
 * execute the rendered script in a sandboxed fake PATH. The Electron GUI
 * installer name (`ponterdesktop`) differs from the installed binary
 * (`ponter`), so the rendered paths are what upgrades/removals touch.
 *
 * Every side-effecting command is shadowed by a logging shim, so the test
 * never touches the real `/usr/bin` link or the alternatives database — even
 * for the erase path.
 */
function runRenderedAfterRemove(argv1: string): {
  status: number;
  sideEffects: string[];
} {
  const appRoot = process.cwd();
  const template = normalizeLineEndings(
    readFileSync(resolve(appRoot, 'build/after-remove.sh'), 'utf8'),
  );
  const rendered = template
    .replace(/\$\{executable\}/g, 'ponter')
    .replace(/\$\{sanitizedProductName\}/g, 'ponterdesktop');
  const workspace = mkdtempSync(join(tmpdir(), 'ponter-after-remove-'));
  const bin = join(workspace, 'bin');
  const scriptPath = join(workspace, 'after-remove.sh');
  const logPath = join(workspace, 'side-effects.log');
  const commands = [
    'update-alternatives',
    'rm',
    'update-desktop-database',
    'update-mime-database',
  ];

  try {
    mkdirSync(bin, { recursive: true });
    for (const command of commands) {
      const shimPath = join(bin, command);
      writeFileSync(
        shimPath,
        `#!/bin/sh\nprintf '%s\\n' "${command} $*" >> "$AFTER_REMOVE_LOG"\n`,
      );
      chmodSync(shimPath, 0o755);
    }
    writeFileSync(scriptPath, rendered);
    chmodSync(scriptPath, 0o755);
    execFileSync('bash', [scriptPath, argv1], {
      cwd: workspace,
      env: {
        ...process.env,
        AFTER_REMOVE_LOG: logPath,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      },
      stdio: 'pipe',
    });
    const sideEffects = existsSync(logPath)
      ? normalizeLineEndings(readFileSync(logPath, 'utf8'))
          .split('\n')
          .filter((line) => line.length > 0)
      : [];
    return { status: 0, sideEffects };
  } catch (error: unknown) {
    const status =
      typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : 1;
    const sideEffects = existsSync(logPath)
      ? normalizeLineEndings(readFileSync(logPath, 'utf8'))
          .split('\n')
          .filter((line) => line.length > 0)
      : [];
    return { status, sideEffects };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe('Linux package removal', () => {
  it('normalizes Windows line endings before assertions', () => {
    expect(normalizeLineEndings('rpm:\r\n  afterRemove: hook\r\n')).toBe(
      'rpm:\n  afterRemove: hook\n',
    );
    expect(normalizeLineEndings('rpm:\r  afterRemove: hook\r')).toBe(
      'rpm:\n  afterRemove: hook\n',
    );
  });

  it('uses a guarded custom after-remove scriptlet', () => {
    const appRoot = process.cwd();
    const config = normalizeLineEndings(
      readFileSync(resolve(appRoot, 'electron-builder.yml'), 'utf8'),
    );
    const script = normalizeLineEndings(
      readFileSync(resolve(appRoot, 'build/after-remove.sh'), 'utf8'),
    );

    expect(config).toMatch(
      /^rpm:\n(?: {2}.*\n)* {2}afterRemove: build\/after-remove\.sh$/m,
    );
    expect(
      statSync(resolve(appRoot, 'build/after-remove.sh')).mode & 0o111,
    ).not.toBe(0);
    expect(script).toContain(
      "update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}' || true",
    );
    expect(script).toContain("rm -f '/usr/bin/${executable}'");
    expect(script).toMatch(/\nexit 0\s*$/);
  });

  it('produces no side effects during package upgrades', () => {
    const result = runRenderedAfterRemove('1');

    expect(result.status).toBe(0);
    expect(result.sideEffects).toEqual([]);
  });

  it('removes the installed alternative and link during package erases', () => {
    const result = runRenderedAfterRemove('0');

    expect(result.status).toBe(0);
    expect(result.sideEffects).toEqual([
      'update-alternatives --remove ponter /opt/ponterdesktop/ponter',
      'rm -f /usr/bin/ponter',
      'update-desktop-database /usr/share/applications',
      'update-mime-database /usr/share/mime',
    ]);
  });
});

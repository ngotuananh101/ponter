import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
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
});

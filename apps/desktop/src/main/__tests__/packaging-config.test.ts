import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Linux package removal', () => {
  it('uses a guarded custom after-remove scriptlet', () => {
    const appRoot = process.cwd();
    const config = readFileSync(
      resolve(appRoot, 'electron-builder.yml'),
      'utf8',
    );
    const script = readFileSync(
      resolve(appRoot, 'build/after-remove.sh'),
      'utf8',
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

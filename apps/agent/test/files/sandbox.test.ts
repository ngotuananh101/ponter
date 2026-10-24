import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesRoot, SandboxError } from '../../src/files/sandbox.js';

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'ponter-files-'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'a.txt'), 'hello');
  return dir;
}

function code(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (error) {
    return (error as SandboxError).code;
  }
}

describe('FilesRoot.resolveExisting', () => {
  it('resolves an empty path to the root itself', () => {
    const dir = root();
    expect(FilesRoot.open(dir).resolveExisting('')).toBe(dir);
  });

  it('resolves a nested relative path', () => {
    const dir = root();
    expect(FilesRoot.open(dir).resolveExisting('docs/a.txt')).toBe(
      join(dir, 'docs', 'a.txt'),
    );
  });

  it('rejects a NUL byte', () => {
    const dir = root();
    expect(
      code(() => FilesRoot.open(dir).resolveExisting('docs\0/a.txt')),
    ).toBe('INVALID_PATH');
  });

  it('rejects a backslash on every platform, not only Windows', () => {
    // The Rust checks this unconditionally because a Windows-authored client
    // sends `docs\a.txt` and a POSIX host would otherwise treat it as one
    // filename containing a backslash.
    const dir = root();
    expect(code(() => FilesRoot.open(dir).resolveExisting('docs\\a.txt'))).toBe(
      'INVALID_PATH',
    );
  });

  it('rejects an absolute path', () => {
    const dir = root();
    expect(code(() => FilesRoot.open(dir).resolveExisting('/etc/passwd'))).toBe(
      'INVALID_PATH',
    );
  });

  it('rejects an empty component', () => {
    const dir = root();
    expect(code(() => FilesRoot.open(dir).resolveExisting('docs//a.txt'))).toBe(
      'INVALID_PATH',
    );
    expect(code(() => FilesRoot.open(dir).resolveExisting('docs/'))).toBe(
      'INVALID_PATH',
    );
  });

  it('rejects a "." component', () => {
    const dir = root();
    expect(
      code(() => FilesRoot.open(dir).resolveExisting('./docs/a.txt')),
    ).toBe('INVALID_PATH');
  });

  it('lets ".." through and then rejects the escape by containment', () => {
    // ".." is not an INVALID_PATH: it is legal, and canonicalize resolves it
    // first. The rejection comes from the containment check, which is why the
    // two errors are different and both must exist.
    const dir = root();
    expect(code(() => FilesRoot.open(dir).resolveExisting('docs/../..'))).toBe(
      'PATH_OUTSIDE_ROOT',
    );
  });

  it('rejects a symlink that resolves outside the root', () => {
    const dir = root();
    const outside = mkdtempSync(join(tmpdir(), 'ponter-outside-'));
    writeFileSync(join(outside, 'secret'), 'x');
    symlinkSync(outside, join(dir, 'escape'));
    expect(
      code(() => FilesRoot.open(dir).resolveExisting('escape/secret')),
    ).toBe('PATH_OUTSIDE_ROOT');
  });

  it('accepts a symlink that stays inside the root', () => {
    const dir = root();
    symlinkSync(join(dir, 'docs'), join(dir, 'alias'));
    expect(FilesRoot.open(dir).resolveExisting('alias/a.txt')).toBe(
      join(dir, 'docs', 'a.txt'),
    );
  });

  it('uses component-wise containment, not string prefix', () => {
    const dir = root();
    const sibling = `${dir}2`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'x'), 'x');
    symlinkSync(sibling, join(dir, 'sibling'));
    expect(code(() => FilesRoot.open(dir).resolveExisting('sibling/x'))).toBe(
      'PATH_OUTSIDE_ROOT',
    );
  });

  it('reports NOT_FOUND for a missing path', () => {
    const dir = root();
    expect(code(() => FilesRoot.open(dir).resolveExisting('nope'))).toBe(
      'NOT_FOUND',
    );
  });
});

describe('FilesRoot.resolveParentForCreate', () => {
  it('resolves a valid parent and name', () => {
    const dir = root();
    expect(FilesRoot.open(dir).resolveParentForCreate('docs', 'b.txt')).toBe(
      join(dir, 'docs', 'b.txt'),
    );
  });

  it('treats an empty directory as the root', () => {
    const dir = root();
    expect(FilesRoot.open(dir).resolveParentForCreate('', 'b.txt')).toBe(
      join(dir, 'b.txt'),
    );
  });

  it('rejects a name containing a slash, a backslash, a NUL, or a dot', () => {
    const dir = root();
    for (const name of ['a/b', 'a\\b', 'a\0b', '.', '..', '']) {
      expect(
        code(() => FilesRoot.open(dir).resolveParentForCreate('docs', name)),
      ).toBe('INVALID_PATH');
    }
  });

  it('rejects a parent that is a file', () => {
    const dir = root();
    expect(
      code(() => FilesRoot.open(dir).resolveParentForCreate('docs/a.txt', 'b')),
    ).toBe('NOT_A_DIRECTORY');
  });
});

describe('FilesRoot.open', () => {
  it('rejects a root that does not exist', () => {
    expect(
      code(() => FilesRoot.open(join(tmpdir(), 'definitely-not-here'))),
    ).toBe('NOT_FOUND');
  });

  it('rejects a root that is a file', () => {
    const dir = root();
    expect(code(() => FilesRoot.open(join(dir, 'docs', 'a.txt')))).toBe(
      'NOT_A_DIRECTORY',
    );
  });
});

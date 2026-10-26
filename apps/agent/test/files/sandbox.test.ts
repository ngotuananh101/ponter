import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FilesRoot } from '../../src/files/sandbox.js';
import type { SandboxError } from '../../src/files/sandbox.js';

/** Every temp dir this file creates, removed once the file finishes. */
const TMP_DIRS: string[] = [];
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

// `force` so a cell that removed its own tree cannot fail the file from a
// teardown; `recursive` because the fixtures nest `docs/` and symlinks.
afterAll(() => {
  for (const dir of TMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

function root() {
  const dir = tmpDir('ponter-files-');
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
    const outside = tmpDir('ponter-outside-');
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
    // NOT `tmpDir()`: the name is this cell's subject. `${dir}2` shares a
    // STRING prefix with `dir` while not being path-contained by it, so a
    // naive `startsWith` containment accepts the symlink. A generated name
    // would share only `/tmp/ponter-` and this cell would pass under that
    // mutant — the assertion would be satisfied by the absence of a signal.
    // Registered instead, so the teardown in `afterAll` still removes it.
    const sibling = `${dir}2`;
    mkdirSync(sibling);
    TMP_DIRS.push(sibling);
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

  it('accepts a path under a root of "/" (defect 8)', () => {
    // `this.root + sep` is `'//'` when the root is `/`, and no absolute path
    // but `//` starts with that — so `AGENT_FILES_ROOT=/` rejected every path
    // with `PATH_OUTSIDE_ROOT`. Fail-closed, so not an escape, but the whole
    // files feature was dead under that root.
    //
    // The wire path must be relative, so the probe strips the leading `/` from
    // a real file's canonical path: under a root of `/` that IS the wire path,
    // and it reaches `ensureContained` with a canonical target that is not the
    // root itself.
    const real = realpathSync(join(root(), 'docs', 'a.txt'));
    const slashRoot = FilesRoot.open('/');
    expect(slashRoot.resolveExisting(real.replace(/^\/+/, ''))).toBe(real);
    // Positive control in the same invocation: the same root still refuses a
    // path that genuinely escapes it is impossible (`/` contains everything),
    // so the control is that a path CANNOT be resolved from a root that does
    // not contain it — measured against a nested root, the shape the check was
    // written for.
    const nested = FilesRoot.open(join(real, '..'));
    expect(code(() => nested.resolveExisting('../../../etc/passwd'))).toBe(
      'PATH_OUTSIDE_ROOT',
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

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import type { FilesErrorCode } from '@ponter/shared';

/**
 * **R11: the shared union, re-exported, not redeclared.** The Rust had one
 * `FilesErrorCode` and the browser has one (`packages/shared/src/types/files.ts`
 * `:98-114`); a second literal here would be byte-identical today and drift
 * silently tomorrow, because nothing relates the two. `export type` rather
 * than a fresh declaration, so a consumer that imports it from `sandbox.js`
 * still compiles and `tsc` still catches a code the shared union rejects.
 *
 * The re-export keeps this module's existing import surface while making the
 * shared package the only definition.
 */
export type { FilesErrorCode };

export class SandboxError extends Error {
  constructor(
    readonly code: FilesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export function errnoToCode(error: unknown): FilesErrorCode {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'NOT_FOUND';
  if (code === 'EEXIST') return 'FILE_EXISTS';
  if (code === 'EACCES' || code === 'EPERM') return 'PERMISSION_DENIED';
  if (code === 'ENOTDIR') return 'NOT_A_DIRECTORY';
  if (code === 'EISDIR') return 'NOT_A_DIRECTORY';
  return 'IO_ERROR';
}

/**
 * The sandbox (B44), in the Rust's exact seven-step order.
 *
 * Order is load-bearing, not stylistic:
 *
 * 1. NUL, 2. backslash, 3. absolute, 4. component-wise join — the cheap textual
 * rejections come first so a hostile client cannot make the agent touch the
 * filesystem before the path is known to be well-formed.
 *
 * `..` is **allowed through step 4** and resolved by `realpath` in step 6. That
 * is deliberate and is why `..` produces `PATH_OUTSIDE_ROOT` rather than
 * `INVALID_PATH`: rejecting it textually would refuse legitimate
 * `docs/../a.txt`, while resolving it and then checking containment catches the
 * escape and the legitimate case with the same code path.
 *
 * Containment is **component-wise**, not a string prefix: `/srv/files2` must not
 * be inside `/srv/files`, and `startsWith` would say it is.
 *
 * `realpath` also resolves symlinks, which is the only check that catches a link
 * planted inside the sandbox pointing anywhere else.
 */
export class FilesRoot {
  private constructor(readonly root: string) {}

  static open(root: string): FilesRoot {
    let canonical: string;
    try {
      canonical = realpathSync(root);
    } catch (error) {
      throw new SandboxError(
        errnoToCode(error),
        `files root ${root} is not resolvable`,
      );
    }
    if (!statSync(canonical).isDirectory()) {
      throw new SandboxError(
        'NOT_A_DIRECTORY',
        `files root ${root} is not a directory`,
      );
    }
    try {
      // The Rust probes `read_dir` so an unreadable root closes the gate at
      // startup rather than at the first listing (ADR-32). `stat` is not a
      // substitute: it succeeds on a mode-000 directory the agent owns, which
      // is exactly the case the probe exists for.
      readdirSync(canonical);
    } catch (error) {
      throw new SandboxError(
        errnoToCode(error),
        `files root ${root} is not readable`,
      );
    }
    return new FilesRoot(canonical);
  }

  resolveExisting(wirePath: string): string {
    const joined = this.joinWire(wirePath);
    let canonical: string;
    try {
      canonical = realpathSync(joined);
    } catch (error) {
      throw new SandboxError(errnoToCode(error), `cannot resolve ${wirePath}`);
    }
    this.ensureContained(canonical, wirePath);
    return canonical;
  }

  resolveParentForCreate(wireDir: string, name: string): string {
    if (name === '' || name === '.' || name === '..') {
      throw new SandboxError('INVALID_PATH', 'name is not a valid file name');
    }
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
      throw new SandboxError(
        'INVALID_PATH',
        'name must not contain a path separator',
      );
    }
    const parent = this.resolveExisting(wireDir);
    if (!statSync(parent).isDirectory()) {
      throw new SandboxError(
        'NOT_A_DIRECTORY',
        `${wireDir} is not a directory`,
      );
    }
    // The target is NOT canonicalised: it does not exist yet.
    return join(parent, name);
  }

  private joinWire(wirePath: string): string {
    if (wirePath.includes('\0'))
      throw new SandboxError('INVALID_PATH', 'path contains a NUL');
    if (wirePath.includes('\\')) {
      throw new SandboxError(
        'INVALID_PATH',
        'backslash is not a POSIX path separator',
      );
    }
    if (isAbsolute(wirePath))
      throw new SandboxError('INVALID_PATH', 'path must be relative');
    if (wirePath === '') return this.root;

    let current = this.root;
    for (const component of wirePath.split('/')) {
      if (component === '') {
        throw new SandboxError('INVALID_PATH', 'empty path component');
      }
      if (component === '.')
        throw new SandboxError('INVALID_PATH', 'dot path component');
      current = join(current, component);
    }
    return current;
  }

  private ensureContained(canonical: string, wirePath: string): void {
    if (canonical === this.root) return;
    if (!canonical.startsWith(this.root + sep)) {
      throw new SandboxError(
        'PATH_OUTSIDE_ROOT',
        `${wirePath} resolves outside the files root`,
      );
    }
  }
}

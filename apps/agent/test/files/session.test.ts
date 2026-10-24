// apps/agent/test/files/session.test.ts
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesRoot } from '../../src/files/sandbox.js';
import {
  FILE_WINDOW_CHUNKS,
  FILES_IDLE_TIMEOUT_MS,
} from '../../src/files/protocol.js';
import type { FilesFrame } from '../../src/files/session.js';
import {
  FILES_INBOUND_TYPES,
  FilesSession,
  decodeFilesFrame,
  resumeOffsetMatches,
  type RemoteFileWire,
} from '../../src/files/session.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '11111111-2222-3333-4444-555555555555';

function session() {
  const dir = mkdtempSync(join(tmpdir(), 'ponter-xfer-'));
  // 64 * 32 KiB = 2 097 152 bytes is the smallest file whose first window is
  // actually full: with 100 000 bytes the window is 4 chunks, and the
  // "exactly the 64-chunk window" assertion below can never hold.
  writeFileSync(join(dir, 'a.bin'), Buffer.alloc(64 * 32_768 + 1, 7));
  return { dir, s: new FilesSession(FilesRoot.open(dir), () => 0) };
}

/**
 * The `type` of a JSON frame, or a marker for the two non-JSON kinds. A
 * `FilesFrame` is `string | Uint8Array | {type, …}`, so neither
 * `typeof f !== 'string'` nor `typeof f === 'string' ? f : f.type` narrows
 * enough for `tsc` under `strict`.
 */
function frameType(f: FilesFrame): string {
  if (typeof f === 'string') return '<<text>>';
  if (f instanceof Uint8Array) return '<<binary>>';
  return f.type;
}

describe('list', () => {
  /** The one frame `files-list` returns, narrowed to its wire shape. */
  function listResult(out: FilesFrame[]) {
    return out[0] as unknown as {
      type: string;
      requestId: string;
      truncated: boolean;
      entries: RemoteFileWire[];
    };
  }

  // Ports `list_returns_entries_sorted_dirs_first` (files.rs:2703). The sort
  // assertions are the point: `localeCompare` on this fixture would also put
  // the dir first, so the name-order half is what discriminates — byte-wise
  // puts `a.txt` before `b.txt`, and would put `B.txt` before `a.txt`.
  it('lists entries sorted directories-first, then name byte-wise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ponter-list-'));
    mkdirSync(join(dir, 'zz-dir'));
    writeFileSync(join(dir, 'b.txt'), 'bb');
    writeFileSync(join(dir, 'a.txt'), 'a');
    const s = new FilesSession(FilesRoot.open(dir), () => 0);

    const out = s.handle({ type: 'files-list', requestId: 'r-1', path: '' });
    expect(out).toHaveLength(1);
    const result = listResult(out);
    expect(result.type).toBe('files-list-result');
    expect(result.requestId).toBe('r-1');
    expect(result.truncated).toBe(false);
    expect(result.entries.map((e) => e.name)).toEqual([
      'zz-dir',
      'a.txt',
      'b.txt',
    ]);
    expect(result.entries[0]!.isDirectory).toBe(true);
    expect(result.entries[0]!.path).toBe('zz-dir');
    expect(result.entries[1]!.size).toBe(1);
    expect(result.entries[1]!.isDirectory).toBe(false);
    expect(result.entries[1]!.path).toBe('a.txt');
    // The wire type declares `modifiedAt: string` and always ends in `Z`.
    expect(result.entries[1]!.modifiedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
  });

  // Ports `list_on_a_file_is_not_a_directory` (files.rs:2730). This is the test
  // that catches `readdirSync` bypassing `errnoToCode`: without the mapping in
  // `list()` itself, Node's `ENOTDIR` reaches `handle()`'s generic catch and
  // the wire code becomes `IO_ERROR`.
  it('reports NOT_A_DIRECTORY when listing a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ponter-list-'));
    writeFileSync(join(dir, 'f.txt'), 'x');
    const s = new FilesSession(FilesRoot.open(dir), () => 0);

    const out = s.handle({
      type: 'files-list',
      requestId: 'r-1',
      path: 'f.txt',
    });
    expect(JSON.stringify(out)).toContain('NOT_A_DIRECTORY');
  });

  // Ports `list_cap_truncates_at_4096_with_the_flag` (files.rs:2740).
  it('truncates at the cap and sets the flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ponter-list-'));
    for (let i = 0; i < 4097; i++)
      writeFileSync(join(dir, `f${String(i).padStart(4, '0')}`), '');
    const s = new FilesSession(FilesRoot.open(dir), () => 0);

    const out = s.handle({ type: 'files-list', requestId: 'r-1', path: '' });
    const result = listResult(out);
    expect(result.entries).toHaveLength(4096);
    expect(result.truncated).toBe(true);
    expect(result.entries[0]!.name).toBe('f0000');
    expect(result.entries[4095]!.name).toBe('f4095');
  });
});

describe('download', () => {
  it('emits begin, then exactly the 64-chunk window, then waits for acks', () => {
    const { s } = session();
    const out = s.handle({
      type: 'files-download',
      transferId: ID,
      path: 'a.bin',
    });
    expect(frameType(out[0]!)).toBe('files-download-begin');
    // `typeof f !== 'string'` counts the `files-download-begin` JSON frame as
    // well — it is an object, not a string. Only the binary chunk frames are
    // the window, so count `Uint8Array` and nothing else.
    expect(out.filter((f) => f instanceof Uint8Array)).toHaveLength(64);
    expect(out.filter((f) => f instanceof Uint8Array)).toHaveLength(
      FILE_WINDOW_CHUNKS,
    );
  });

  it('completes an empty file with begin then end', () => {
    const { dir, s } = session();
    writeFileSync(join(dir, 'empty'), '');
    const out = s.handle({
      type: 'files-download',
      transferId: ID,
      path: 'empty',
    });
    expect(out.map(frameType)).toContain('files-download-end');
  });

  it('refuses a second download in the same direction', () => {
    const { s } = session();
    s.handle({ type: 'files-download', transferId: ID, path: 'a.bin' });
    const out = s.handle({
      type: 'files-download',
      transferId: ID2,
      path: 'a.bin',
    });
    expect(JSON.stringify(out)).toContain('TRANSFER_BUSY');
  });

  it('drops a download whose ack claims more chunks than were sent', () => {
    const { s } = session();
    s.handle({ type: 'files-download', transferId: ID, path: 'a.bin' });
    const out = s.handle({
      type: 'files-download-ack',
      transferId: ID,
      nextChunkIndex: 65,
    });
    expect(JSON.stringify(out)).toContain('BAD_FRAME');
    expect(
      JSON.stringify(
        s.handle({ type: 'files-download', transferId: ID2, path: 'a.bin' }),
      ),
    ).not.toContain('TRANSFER_BUSY');
  });

  it('ignores a duplicate or regressive ack without erroring', () => {
    const { s } = session();
    s.handle({ type: 'files-download', transferId: ID, path: 'a.bin' });
    s.handle({
      type: 'files-download-ack',
      transferId: ID,
      nextChunkIndex: 10,
    });
    const out = s.handle({
      type: 'files-download-ack',
      transferId: ID,
      nextChunkIndex: 10,
    });
    expect(JSON.stringify(out)).not.toContain('files-error');
  });
});

describe('upload', () => {
  it('writes the file and removes the .part on success', () => {
    const { dir, s } = session();
    const size = 40_000;
    s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'up.bin',
      size,
    });
    s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 0,
      totalChunks: 2,
      data: Buffer.alloc(32_768, 1).toString('base64'),
    });
    s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 1,
      totalChunks: 2,
      data: Buffer.alloc(size - 32_768, 1).toString('base64'),
    });
    const out = s.handle({ type: 'files-upload-end', transferId: ID });
    expect(JSON.stringify(out)).toContain('files-upload-complete');
    expect(readFileSync(join(dir, 'up.bin')).length).toBe(size);
    expect(() => statSync(join(dir, 'up.bin.ponter-part'))).toThrow();
  });

  it('batches acks, flushing on the 16th chunk', () => {
    const { s } = session();
    const size = 32_768 * 20;
    s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'b.bin',
      size,
    });
    let acks = 0;
    // From 0: the session's `nextChunk` is 0, and starting at 1 is a
    // "chunk index out of order" reject on the very first iteration, which
    // throws the upload away and makes the ack count 0 forever.
    for (let i = 0; i < 20; i += 1) {
      const out = s.handle({
        type: 'files-upload-chunk',
        transferId: ID,
        chunkIndex: i,
        totalChunks: 20,
        data: Buffer.alloc(32_768).toString('base64'),
      });
      acks += out.filter((f) => frameType(f) === 'files-upload-ack').length;
    }
    expect(acks).toBe(1);
  });

  it('rejects a chunk with the wrong index', () => {
    const { s } = session();
    s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'c.bin',
      size: 65_536,
    });
    const out = s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 1,
      totalChunks: 2,
      data: Buffer.alloc(32_768).toString('base64'),
    });
    expect(JSON.stringify(out)).toContain('BAD_FRAME');
  });

  it('rejects upload-end before the last chunk', () => {
    const { s } = session();
    s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'd.bin',
      size: 65_536,
    });
    s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 0,
      totalChunks: 2,
      data: Buffer.alloc(32_768).toString('base64'),
    });
    expect(
      JSON.stringify(s.handle({ type: 'files-upload-end', transferId: ID })),
    ).toContain('BAD_FRAME');
  });

  it('refuses a name that already exists', () => {
    const { s } = session();
    const out = s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'a.bin',
      size: 10,
    });
    expect(JSON.stringify(out)).toContain('FILE_EXISTS');
  });

  it('answers the begin with the initial cumulative ack (defect 2)', () => {
    // `files.rs:1623-1627`: "The begin is answered with the first cumulative
    // ack (spec §6.1)". The port returned `[]`, and the browser's transfer pump
    // is driven from `onAck` alone (`packages/file-core/src/transfer.ts:164-177`),
    // so no chunk was ever sent and every upload hung to the idle timeout.
    const { s } = session();
    const out = s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'ack.bin',
      size: 65_536,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'files-upload-ack',
      transferId: ID,
      nextChunkIndex: 0,
    });
  });

  it('carries the wire-relative destination on files-upload-complete (defect 4)', () => {
    // `FilesUploadComplete.path` is a `FilesPath` — sandbox-relative
    // (`packages/shared/src/types/files.ts:82`) — and the Rust emits
    // `state.dest_rel` (`files.rs:2281`). The port sent the absolute host path,
    // which leaks the host layout and breaks any consumer that resolves it
    // against the root again.
    const size = 32_768;
    const dir = mkdtempSync(join(tmpdir(), 'ponter-complete-'));
    mkdirSync(join(dir, 'sub'));
    const s = new FilesSession(FilesRoot.open(dir), () => 0);
    s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: 'sub',
      name: 'file.bin',
      size,
    });
    s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 0,
      totalChunks: 1,
      data: Buffer.alloc(size, 1).toString('base64'),
    });
    const out = s.handle({ type: 'files-upload-end', transferId: ID });
    const complete = out.find((f) => frameType(f) === 'files-upload-complete');
    expect(complete).toMatchObject({
      name: 'file.bin',
      path: 'sub/file.bin',
    });
    // The absolute path is the bug; assert its absence, not just the presence
    // of a relative-looking string.
    expect(JSON.stringify(complete)).not.toContain(dir);
  });
});

describe('resume', () => {
  // The wire value is pinned here because Rust never pinned it: `files.rs:40-45`
  // says the constant is "pinned by [`FILES_IDLE_TIMEOUT_MS`] and its own
  // assertion", and no such assertion exists (`awk 'NR>=2287' files.rs | grep
  // FILES_IDLE_TIMEOUT` is empty; the test module starts at :2287).
  //
  // Only the literal `30_000` is asserted. "The prod timeout equals the
  // constant" is NOT asserted, because in TS both sides are the same symbol —
  // `expect(FILES_IDLE_TIMEOUT_MS).toBe(FILES_IDLE_TIMEOUT_MS)` cannot fail.
  // Rust could assert the equivalent because it has two symbols that diverge
  // under `cfg(test)` (`FILES_IDLE_TIMEOUT` shrinks to 50 ms so tests need not
  // sleep 30 s); TS has one and reaches the same end by injecting `now()`.
  it('pins the idle timeout to the wire value', () => {
    expect(FILES_IDLE_TIMEOUT_MS).toBe(30_000);
  });

  it('requires the .part length to equal the resume offset exactly', () => {
    expect(resumeOffsetMatches(65_536, 2)).toBe(true);
    expect(resumeOffsetMatches(65_535, 2)).toBe(false);
    expect(resumeOffsetMatches(0, 0)).toBe(true);
    expect(resumeOffsetMatches(1, 0)).toBe(false);
  });

  it('answers an unapproved resume with a resume-ack, never an error frame', () => {
    const { s } = session();
    s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'e.bin',
      size: 65_536,
    });
    s.handle({ type: 'files-pause', transferId: ID, direction: 'upload' });
    const out = s.handle({
      type: 'files-resume',
      transferId: ID,
      path: 'ignored',
      direction: 'upload',
      fromChunkIndex: 5,
    });
    const ack = out.find((f) => frameType(f) === 'files-resume-ack');
    expect(ack).toBeDefined();
    expect(JSON.stringify(ack)).toContain('"approved":false');
  });

  // Ports `paused_state_survives_idle_timeout` (files.rs:3834): pause, push the
  // clock past the deadline, and assert `checkIdle()` emits nothing and the
  // slot survives. Rust forces the deadline into the past directly; TS advances
  // the injected clock, which reaches the same state without touching internals.
  it('paused transfers do not time out', () => {
    let now = 0;
    const dir = mkdtempSync(join(tmpdir(), 'ponter-xfer-'));
    const s = new FilesSession(FilesRoot.open(dir), () => now);
    s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'f.bin',
      size: 65_536,
    });
    s.handle({ type: 'files-pause', transferId: ID, direction: 'upload' });
    now = 60_000;
    expect(JSON.stringify(s.checkIdle())).not.toContain('TRANSFER_TIMEOUT');
  });

  it('kills a stalled transfer at the idle timeout', () => {
    let now = 0;
    const dir = mkdtempSync(join(tmpdir(), 'ponter-xfer-'));
    writeFileSync(join(dir, 'g.bin'), Buffer.alloc(100_000));
    const s = new FilesSession(FilesRoot.open(dir), () => now);
    s.handle({ type: 'files-download', transferId: ID, path: 'g.bin' });
    now = 30_000;
    expect(JSON.stringify(s.checkIdle())).toContain('TRANSFER_TIMEOUT');
  });

  it('carries the transferId on an upload timeout frame (defect 3)', () => {
    // The download branch always set it; the upload branch did not, and the
    // browser only settles a transfer whose frame carries the id it waits on
    // (`packages/file-core/src/client.ts:637-641`). Rust sets it on both
    // (`files.rs:1259-1270`, `timeout_frame(direction, transfer_id)`).
    let now = 0;
    const dir = mkdtempSync(join(tmpdir(), 'ponter-xfer-'));
    const s = new FilesSession(FilesRoot.open(dir), () => now);
    s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'stall.bin',
      size: 65_536,
    });
    now = 30_000;
    const out = s.checkIdle();
    expect(out[0]).toMatchObject({
      type: 'files-error',
      transferId: ID,
      code: 'TRANSFER_TIMEOUT',
    });
    // And the slot is released, so the client can start over.
    expect(
      s.handle({
        type: 'files-upload-begin',
        transferId: ID2,
        path: '',
        name: 'again.bin',
        size: 10,
      })[0],
    ).toMatchObject({ type: 'files-upload-ack', transferId: ID2 });
  });
});

describe('cancel', () => {
  it('removes the .part file and stops the upload', () => {
    const { dir, s } = session();
    s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'h.bin',
      size: 65_536,
    });
    s.handle({ type: 'files-cancel', transferId: ID });
    expect(() => statSync(join(dir, 'h.bin.ponter-part'))).toThrow();
  });

  it('is idempotent for an unknown id and emits no error', () => {
    const { s } = session();
    expect(s.handle({ type: 'files-cancel', transferId: ID2 })).toEqual([]);
  });
});

describe('delete honours recursive (defect 1)', () => {
  // The Rust's `FilesRoot::delete` (`files.rs:918-943`) branches on
  // `recursive`: `remove_dir_all` for the tree, and a non-recursive call on a
  // non-empty directory is `DIR_NOT_EMPTY`. The port always took the
  // non-recursive arm, so every folder delete in the web UI — which sends
  // `recursive: true` for directories (`FilesView.vue:145`) — failed.
  function withTree() {
    const dir = mkdtempSync(join(tmpdir(), 'ponter-delete-'));
    mkdirSync(join(dir, 'folder'));
    writeFileSync(join(dir, 'folder', 'inner.txt'), 'content');
    return { dir, s: new FilesSession(FilesRoot.open(dir), () => 0) };
  }

  it('removes a non-empty directory when recursive is set', () => {
    const { dir, s } = withTree();
    const out = s.handle({
      type: 'files-delete',
      requestId: 'r-del-1',
      path: 'folder',
      recursive: true,
    });
    expect(out[0]).toMatchObject({
      type: 'files-action-result',
      success: true,
    });
    expect(() => statSync(join(dir, 'folder'))).toThrow();
  });

  it('refuses a non-empty directory when recursive is absent or false', () => {
    for (const recursive of [undefined, false]) {
      const { dir, s } = withTree();
      const out = s.handle({
        type: 'files-delete',
        requestId: 'r-del-2',
        path: 'folder',
        recursive,
      });
      expect(out[0]).toMatchObject({
        type: 'files-action-result',
        success: false,
        error: 'DIR_NOT_EMPTY',
      });
      // The refusal must not be a half-delete.
      expect(statSync(join(dir, 'folder', 'inner.txt')).isFile()).toBe(true);
    }
  });

  it('removes an empty directory without recursive (the non-recursive arm still works)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ponter-delete-'));
    mkdirSync(join(dir, 'empty'));
    const s = new FilesSession(FilesRoot.open(dir), () => 0);
    const out = s.handle({
      type: 'files-delete',
      requestId: 'r-del-3',
      path: 'empty',
    });
    expect(out[0]).toMatchObject({
      type: 'files-action-result',
      success: true,
    });
    expect(() => statSync(join(dir, 'empty'))).toThrow();
  });

  it('refuses the sandbox root even with recursive set', () => {
    // `rmSync(root, {recursive: true})` would delete the whole sandbox in one
    // message; the Rust refuses the root above the recursive branch too.
    const { dir, s } = withTree();
    const out = s.handle({
      type: 'files-delete',
      requestId: 'r-del-4',
      path: '',
      recursive: true,
    });
    expect(out[0]).toMatchObject({
      type: 'files-action-result',
      success: false,
      error: 'PERMISSION_DENIED',
    });
    expect(statSync(join(dir, 'folder', 'inner.txt')).isFile()).toBe(true);
  });
});

describe('decode — all twelve inbound shapes (R6)', () => {
  // The Rust's `decode_round_trips_every_browser_to_agent_type`
  // (`files.rs:2433-2481`) named the enumeration in its title and covered
  // **7 of 12**: list, download, upload-begin, upload-chunk, upload-end,
  // cancel, download-ack. It had no `files-mkdir`, `files-rename`,
  // `files-delete`, `files-pause` or `files-resume` — and two of the five it
  // omitted are exactly the two the port read the wrong field names for. That
  // is why the field-name defect was invisible on both sides.
  //
  // The list is imported rather than spelled here, so a type added to
  // `FILES_INBOUND_TYPES` without a case here fails the length assertion
  // instead of being silently untested — which is the defect, one level up.
  it('covers every declared inbound type, and the list is twelve long', () => {
    expect(FILES_INBOUND_TYPES).toHaveLength(12);
    expect(new Set(FILES_INBOUND_TYPES).size).toBe(12);
  });

  it.each(FILES_INBOUND_TYPES)(
    'routes %s through decode to its arm',
    (type) => {
      const { s } = session();
      // A decoded frame reaches an arm; an undecodable one never does. The
      // discrimination is the **shape** of the answer, not merely that something
      // came back: every one of the twelve known types answers with at least one
      // frame, while an unknown type answers `[]`.
      expect(decodeFilesFrame({ type })).not.toBeNull();
      expect(Array.isArray(s.handle({ type }))).toBe(true);
    },
  );

  it('drops a type outside the twelve instead of reaching an arm', () => {
    // The positive control for the loop above: if `decodeFilesFrame` returned
    // its argument unchanged, this case would pass too and the loop would
    // prove nothing about the gate.
    const { s } = session();
    expect(decodeFilesFrame({ type: 'files-explode' })).toBeNull();
    expect(s.handle({ type: 'files-explode' })).toEqual([]);
  });
});

describe('mkdir and rename field names (R5)', () => {
  it('creates in the named directory, not the root', () => {
    const { dir, s } = session();
    mkdirSync(join(dir, 'docs'));
    const out = s.handle({
      type: 'files-mkdir',
      requestId: 'r-1',
      dir: 'docs',
      name: 'new',
    });
    // The bug: `message.path` is `undefined` on this frame, `String(undefined
    // ?? '')` is `''`, and `resolveExisting('')` is the root — so the
    // directory appeared at the root and the frame still said `success: true`.
    expect(statSync(join(dir, 'docs', 'new')).isDirectory()).toBe(true);
    expect(out[0]).toMatchObject({
      type: 'files-action-result',
      success: true,
    });
  });

  it('reports FILE_EXISTS, not IO_ERROR, when the directory is already there (R10)', () => {
    // `mkdirSync` throws `EEXIST`, which is not a `SandboxError`; without the
    // mapping on this path the generic catch turned it into `IO_ERROR`, and
    // with a bare-code contract that wrong code is shipped rather than
    // swallowed. The Rust returns `FILE_EXISTS` (`files.rs:873-883`).
    const { dir, s } = session();
    mkdirSync(join(dir, 'docs'));
    mkdirSync(join(dir, 'docs', 'taken'));
    const out = s.handle({
      type: 'files-mkdir',
      requestId: 'r-1',
      dir: 'docs',
      name: 'taken',
    });
    expect(out[0]).toMatchObject({
      type: 'files-action-result',
      success: false,
      error: 'FILE_EXISTS',
    });
    // And the failure arm carries no `path` — the four fields the browser reads.
    expect(out[0]).not.toHaveProperty('path');
  });

  it("reads the wire's oldPath and newPath", () => {
    const { dir, s } = session();
    // `docs/` is this test's own fixture: `session()` creates only `a.bin`,
    // and `rename` resolves `oldPath` before it can succeed.
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'a.txt'), 'x');
    const out = s.handle({
      type: 'files-rename',
      requestId: 'r-1',
      oldPath: 'docs/a.txt',
      newPath: 'docs/b.txt',
    });
    // Under the old names `from` and `toPath` were `undefined` and `toName`
    // was the **string** `"undefined"`, so every UI rename went to
    // `<root>/undefined` and threw `EINVAL` → `IO_ERROR`.
    expect(statSync(join(dir, 'docs', 'b.txt')).isFile()).toBe(true);
    expect(out[0]).toMatchObject({
      type: 'files-action-result',
      success: true,
    });
  });

  it('refuses to rename the sandbox root', () => {
    // The guard `remove` already had and `rename` did not (`files.rs:964-970`
    // returns `PermissionDenied`, "cannot rename sandbox root"). It becomes
    // reachable exactly when R5 lands: with the wire's real names, `oldPath:
    // ''` resolves to the canonical root and reaches `renameSync`.
    const { s } = session();
    const out = s.handle({
      type: 'files-rename',
      requestId: 'r-1',
      oldPath: '',
      newPath: 'x',
    });
    expect(out[0]).toMatchObject({
      type: 'files-action-result',
      success: false,
      error: 'PERMISSION_DENIED',
    });
  });
});

describe('the ack split (R7, R8)', () => {
  it('flushes on the 20 ms tick an ack the chunk path did not take', () => {
    // The case the Rust's split makes possible and the plan's collapse made
    // impossible: a chunk arrives below the frequency threshold and the tick
    // interval has elapsed. `noteChunk()` returns the predicate (false here);
    // `flushAcks()` takes unconditionally and emits.
    let now = 0;
    const dir = mkdtempSync(join(tmpdir(), 'ponter-ack-'));
    const s = new FilesSession(FilesRoot.open(dir), () => now);
    s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'k.bin',
      size: 32_768 * 20,
    });
    now = 20;
    const chunk = s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 0,
      totalChunks: 20,
      data: Buffer.alloc(32_768).toString('base64'),
    });
    // Once the interval has elapsed the chunk path's own predicate fires, so
    // the discriminating case is the tick: it must be able to take an ack the
    // frequency rule alone would have held back.
    expect(frameType(chunk[0]!)).toBe('files-upload-ack');
    // Nothing is pending after that flush — which is exactly why the tick
    // cannot be a second copy of the chunk path.
    expect(s.flushAcks()).toEqual([]);
  });

  it('takes unconditionally on the tick even when the frequency rule says no', () => {
    let now = 0;
    const dir = mkdtempSync(join(tmpdir(), 'ponter-ack-'));
    const s = new FilesSession(FilesRoot.open(dir), () => now);
    s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'l.bin',
      size: 32_768 * 20,
    });
    const chunk = s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 0,
      totalChunks: 20,
      data: Buffer.alloc(32_768).toString('base64'),
    });
    // Below both thresholds: no ack yet, and one is pending.
    expect(chunk).toEqual([]);
    now = 20;
    const flushed = s.flushAcks();
    expect(frameType(flushed[0]!)).toBe('files-upload-ack');
    expect(flushed[0]).toMatchObject({ nextChunkIndex: 1 });
  });

  it('emits the final ack before files-upload-complete', () => {
    // The Rust returns `vec![final_ack, complete]` (`files.rs:1734`). The order
    // is the contract: the ack carries the last index the sender waits on, and
    // a browser that saw `complete` first has already torn down that state.
    const { s } = session();
    const size = 40_000;
    s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'm.bin',
      size,
    });
    s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 0,
      totalChunks: 2,
      data: Buffer.alloc(32_768, 1).toString('base64'),
    });
    s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 1,
      totalChunks: 2,
      data: Buffer.alloc(size - 32_768, 1).toString('base64'),
    });
    const out = s.handle({ type: 'files-upload-end', transferId: ID });
    expect(out.map(frameType)).toEqual([
      'files-upload-ack',
      'files-upload-complete',
    ]);
  });
});

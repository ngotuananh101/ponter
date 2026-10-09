# Phase 4 Week 10 — File Transfer (Thin Slice, Two-Way) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Week 10 file-transfer thin slice: a third session mode `Files` served over one `files` data channel, listing a sandboxed directory, downloading files, and uploading files — **both directions** — behind an agent-local refuse-at-offer gate (`--files-root`, ADR-32) and a canonicalized-root sandbox with `.part` + atomic-rename uploads (ADR-33).

**Architecture:** The browser (new `packages/file-core` `FileClient` + a third web tab kind) and the Rust agent (`apps/agent/src/files.rs`) speak JSON `DataChannelMessage<T>` envelopes on one `'files'` channel (ADR-31). Chunks are 32 KiB raw / base64 (≈43.8 KB framed, under the 64 KiB guard) with an explicit 16-chunk sliding window and cumulative `nextChunkIndex` acks in both directions (ADR-34). The agent classifies the offer (terminal → desktop → files), refuses the whole offer when no usable root is configured (ADR-32), and confines every wire path to one canonicalized root (ADR-33). The server and `packages/webrtc-core` are untouched (ADR-35).

**Tech Stack:** TypeScript (pnpm workspace: `@ponter/shared`, new `@ponter/file-core`, Vue 3 + Pinia), vitest; Rust (`webrtc`/`rtc` 0.21, `tokio`, serde, base64), `cargo test`/`cargo clippy`; werift E2E offerer in `packages/webrtc-core/test/e2e/`; GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-04-phase4-week10-file-transfer-design.md` (ADR-31..35, merged on `main` as `dbe5240`)

> **Reading order:** read the spec's §2 (wire protocol), §4 (ADR-31..35), §5 (`file-core`), §6 (agent), §7 (web) and §10.3 (delivery sequence) before starting. This plan argues from the spec; where they disagree, the spec wins and the plan is wrong.

> **Cite discipline.** Every `file:line` in this plan was verified against `main` at `dbe5240` (2026-10-04), the commit the spec is on. Two spec cites drifted and are corrected here: `.github/workflows/ci-e2e.yml`'s path filters are `:13-21` (push) and `:24-32` (pull_request) — the spec's "`:13-28`" truncates the PR list; and §3.5's claim that `terminal-store.test.ts` mocks `@ponter/file-core` is wrong — it mocks `@ponter/desktop-core` (`apps/web/src/__tests__/terminal-store.test.ts:24-51`); the new `files-store.test.ts` adds the `file-core` mock. If a later PR moves a cite, re-verify before trusting this plan.

## Global Constraints

Copied from the spec's project-wide requirements. Every task's requirements implicitly include this section.

- **Precondition — one worktree per branch, opened from a fresh `origin/main` at `dbe5240`.** The Week 10 spec (PR #38, merged `dbe5240`) must already be on `main`. Never `git checkout` in the shared working directory. Single branch `feat/phase4-week10-file-transfer`; the PR opens to `main` after the whole branch is green.
- **Exact protocol values (spec §2.4, §2.5).** `FILE_CHUNK_BYTES = 32768`; window size **16** chunks; idle timeout **30000 ms**; file cap `FILE_MAX_BYTES = 1 << 30` (1 GiB) enforced on the **declared/stat** size; list cap **4096** entries (directories first, then name byte-wise ascending; `truncated: true`); **one transfer per direction** (a download and an upload may run concurrently); 32 KiB raw → 43 692 base64 chars ≈ 43.8 KB framed < `MAX_FRAME_BYTES = 64 * 1024` (`apps/agent/src/pty.rs:26`).
- **The 12 error codes, exactly these spellings (spec §2.3):** `PATH_OUTSIDE_ROOT`, `INVALID_PATH`, `NOT_FOUND`, `NOT_A_FILE`, `NOT_A_DIRECTORY`, `FILE_EXISTS`, `FILE_TOO_LARGE`, `TRANSFER_BUSY`, `TRANSFER_UNKNOWN`, `TRANSFER_TIMEOUT`, `IO_ERROR`, `BAD_FRAME`. Check order: decode guard → syntactic path (`INVALID_PATH`) → canonicalize + root-prefix (`PATH_OUTSIDE_ROOT`) → existence/type → caps → busy; uploads target must **not** exist (`FILE_EXISTS`).
- **The gate is the point (ADR-32).** `--files-root` (env `AGENT_FILES_ROOT`) is `Option<String>` with **no default**. A `Files` offer is refused **at the offer — before any session is set up, and instead of an approved answer** — when the root is unset, missing, not a directory, or unreadable: `tracing::warn!` + `rtc::refuse_offer` (a real SDP with `approved: false`; R19 forbids sending nothing) + `peer.close()` + `Ok(())` — evaluated **per offer**, never cached at startup. The refusal log line is exactly `refused: files root not configured or unusable`.
- **The sandbox is the other point (ADR-33).** One canonicalized root; every wire path is **POSIX-relative** (`''` = root; `/` on every OS). Reject absolute paths, empty components, `.`/`..` components, and NUL. Resolve via `canonicalize` and require the result to equal the root or start with `root + separator` (defeats `..`, symlink escape, and `/srv/files` vs `/srv/files2` prefix confusion). Uploads write a sibling `{name}.ponter-part`, `flush` + `fsync`, then **rename without replace**; a stale `.part` is removed-and-retried **once**; **no overwrite ever** (`FILE_EXISTS` at begin and at the rename race).
- **Wire shapes are frozen (spec §2.2, §2.3).** Envelope `DataChannelMessage<T>` `{type, channel: 'files', payload, timestamp}` (`apps/agent/src/pty.rs:37-45`). B→A types: `files-list`, `files-download`, `files-upload-begin`, `files-upload-chunk`, `files-upload-end`, `files-cancel`, `files-download-ack`. A→B: `files-list-result`, `files-download-begin`, `files-download-chunk`, `files-download-end`, `files-upload-ack`, `files-upload-complete`, `files-error`. Unknown `type`s warn-and-ignore; malformed frames → `BAD_FRAME` and are **never fatal**. IDs are UUID v4 minted **browser-side** (`crypto.randomUUID`); the agent echoes and never mints.
- **Fail-soft (spec §2.6).** No `files-error`, decode failure, or I/O failure ever ends the session; only the offending transfer/request fails. `files-cancel` for an unknown id is idempotent (log only, no error frame).
- **`packages/webrtc-core` and `apps/server` are untouched (ADR-31/35).** No new channel machinery, no server column/endpoint/migration, `FileTransfer` in `packages/shared/src/types/files.ts:15-27` stays unused. The terminal and desktop flows stay byte-identical; the existing E2E suites pass unchanged.
- **`apps/agent/src/files.rs` is NOT musl-gated** (plain `mod files;` beside `mod pty;`, `main.rs:19-22`) and adds **no dependency** (tokio `features = ["full"]` already provides `tokio::fs`, `apps/agent/Cargo.toml:21`). The musl artifact serves files sessions; the desktop musl stub (`main.rs:1539-1563`) is untouched. `rtc.rs`'s new `send_approved_answer` must be callable on **all** targets (files is not musl-gated), while `send_desktop_answer` keeps its `#[cfg(not(target_env = "musl"))]` and becomes a one-line delegate (`rtc.rs:224-237`).
- **`RemoteFile.modifiedAt` is an RFC 3339 UTC string** (spec §2.3/§6.1). The agent has no direct `time`/`chrono` dependency and adds none: use a std-only epoch→RFC 3339 formatter in `files.rs`, pinned by a unit test. `RemoteFile.mode` stays unpopulated (Unix-only metadata, YAGNI).
- **English for all repo artifacts:** code, comments, commit messages, and docs stay English. The one exception is `docs/ARCHITECTURE.md`, which is written in Vietnamese — its additions match that file's own convention.
- **CI gate names (current):** `Build Agent / Verify`, `Build Agent / Linux/x64-musl`, `CI (Node)`, `CI (E2E) / Cross-language terminal E2E`. There is no `ci.yml`; do not add one.
- **SonarCloud new-code duplication gate (>3% fails).** Any test prologue repeated across tests must be a shared helper from the first commit, not copy-paste. The helpers are named in each task: `makeFakeManager` (`packages/file-core/test`), `openFilesWithClient` (`apps/web/src/__tests__/files-store.test.ts`), `openFilesPeer` + `waitForFilesFrame` (`packages/webrtc-core/test/e2e/harness.ts`), `temp_dir_for_test` (`apps/agent/src/files.rs` tests).
- **No `docs/` demo file is committed by an implementer task; the demo doc (D6) is written by Task 11** at `docs/superpowers/specs/2026-10-04-phase4-week10-demo.md` from the recorded run.

## Review Focus

The spec's highest-risk behaviours (§10.4), each pinned to the test in the task that owns the code:

1. **The gate is the point (ADR-32).** No files code path may run for an offer without a validated root; the refusal is per offer, instead of an approved answer. Pinned in **Task 7, `files_gate_closes_for_every_unusable_root`** (unit: classify + resolve returns `None` → refusal branch) and **Task 10, gate-off E2E** (offer answered `approved: false`, `waitForChannel` rejects, agent log contains `refused: files root not configured or unusable`).
2. **The sandbox is the other point (ADR-33).** Every path check goes through `FilesRoot`; `..`, absolute, symlink-escape, and prefix-confusion cases must all be rejected. Pinned in **Task 4**: `path_policy_rejects_dotdot_escape`, `path_policy_rejects_absolute`, `path_policy_rejects_symlink_escape`, `path_policy_rejects_prefix_confusion`; and **Task 10, path-escape E2E** (`PATH_OUTSIDE_ROOT` on the wire).
3. **One channel, one label (ADR-31).** No new WebRTC machinery; `webrtc-core` and the server untouched; exactly one inbound channel accepted. Pinned in **Task 5** (`FILES_LABEL` constant + `send_approved_answer` used by files without touching `answer_offer`'s terminal-only check at `rtc.rs:722`), **Task 7** (`classify_offer` precedence), and **Task 10** (the E2E opens one `['files']` channel; existing suites pass unchanged).
4. **Both directions use one chunk shape and one ack scheme (ADR-34).** Divergence between the Rust and TS state machines is the likeliest implementation bug. Pinned in **Task 3** (`transfer.test.ts`: window arithmetic, ack monotonicity, gap → `BAD_FRAME`, chunk-length validation, idle timeout) and **Task 6** (`upload_ack_stream_is_cumulative`, `chunk_length_mismatch_is_bad_frame`, `download_acks_gate_the_window`) — same rules, same codes, both sides.
5. **Fail-soft (spec §2.6).** No `files-error`, decode failure, or I/O failure ends a session; only the offending transfer fails. Pinned in **Task 4** (`decode_guard_never_errors_on_foreign_frames`), **Task 6** (`cancel_stops_the_download_and_removes_the_state`, `cancel_of_an_upload_removes_the_part_file`, `cancel_for_an_unknown_id_is_idempotent`) and **Task 10, cancel-mid-download E2E** (no further chunks, session serves a later `files-list`).
6. **Honesty (§10.2).** No task claims throughput or E2EE; the demo doc (Task 11) records the informal number and the gate-closed run. Pinned in **Task 11's checklist table** (no row claims "usable against an unverified peer").

---

### Task 1: `packages/shared` — file wire types (D1)

**Files:**
- Modify: `packages/shared/src/types/files.ts` (append payload interfaces + `FilesErrorCode` + `FilesPath`)
- Modify: `packages/shared/src/types/index.ts:29-35` (extend the `./files.js` re-export block)
- Test: `packages/shared/test/file-types.test.ts` (new file)

**Interfaces:**
- Consumes: `RemoteFile`, `FileChunkMessage` (already in `files.ts:6-13, :29-34`); nothing else.
- Produces (relied on by **Tasks 2, 3, 4, 6, 7, 8, 9, 10**):
  - `FilesPath = string` (POSIX-relative; `''` = root)
  - `FilesListRequest { requestId, path }`, `FilesListResult { requestId, path, entries, truncated }`
  - `FilesDownloadRequest { transferId, path }`, `FilesDownloadBegin { transferId, name, path, size, totalChunks }`, `FilesDownloadEnd { transferId }`
  - `FilesUploadBeginRequest { transferId, path, name, size }`, `FilesUploadEndRequest { transferId }`, `FilesUploadComplete { transferId, name, path, size }`
  - `FilesAckMessage { transferId, nextChunkIndex }`, `FilesCancelMessage { requestId?, transferId? }`
  - `FilesErrorCode` (the 12-string union), `FilesErrorMessage { requestId?, transferId?, code, message }`

> **No new envelope, no channel change.** `WebRTCChannelType` already includes `'files'` (`packages/shared/src/types/webrtc.ts:7`); do not re-add it. These are payload shapes only (spec §5.1).

- [ ] **Step 1: Write the failing type tests**

Create `packages/shared/test/file-types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type {
  FilesAckMessage,
  FilesCancelMessage,
  FilesDownloadBegin,
  FilesDownloadEnd,
  FilesDownloadRequest,
  FilesErrorMessage,
  FilesErrorCode,
  FilesListRequest,
  FilesListResult,
  FilesPath,
  FilesUploadBeginRequest,
  FilesUploadComplete,
  FilesUploadEndRequest,
} from '../src';
import type { FileChunkMessage, RemoteFile } from '../src';

describe('File transfer wire types (Week 10, spec §2.3)', () => {
  it('instantiates a list request and result with relative paths', () => {
    const req: FilesListRequest = { requestId: 'r-1', path: '' };
    const root: FilesPath = '';
    const entry: RemoteFile = {
      name: 'notes.txt',
      path: 'docs/notes.txt',
      size: 12,
      isDirectory: false,
      modifiedAt: '2026-10-04T12:00:00Z',
    };
    const res: FilesListResult = {
      requestId: req.requestId,
      path: root,
      entries: [entry],
      truncated: false,
    };
    expect(res.entries[0]?.path).toBe('docs/notes.txt');
    expect(res.truncated).toBe(false);
  });

  it('instantiates the download lifecycle payloads', () => {
    const req: FilesDownloadRequest = { transferId: 't-1', path: 'a.bin' };
    const begin: FilesDownloadBegin = {
      transferId: req.transferId,
      name: 'a.bin',
      path: req.path,
      size: 32769,
      totalChunks: 2,
    };
    const end: FilesDownloadEnd = { transferId: req.transferId };
    expect(begin.totalChunks).toBe(2);
    expect(end.transferId).toBe(begin.transferId);
  });

  it('instantiates the upload lifecycle payloads', () => {
    const begin: FilesUploadBeginRequest = {
      transferId: 't-2',
      path: 'dir',
      name: 'up.bin',
      size: 0,
    };
    const end: FilesUploadEndRequest = { transferId: begin.transferId };
    const complete: FilesUploadComplete = {
      transferId: begin.transferId,
      name: 'up.bin',
      path: 'dir/up.bin',
      size: 0,
    };
    expect(complete.path).toBe('dir/up.bin');
    expect(end.transferId).toBe(complete.transferId);
  });

  it('carries a cumulative ack and an optional cancel id', () => {
    const ack: FilesAckMessage = { transferId: 't-1', nextChunkIndex: 3 };
    const cancelTransfer: FilesCancelMessage = { transferId: 't-1' };
    const cancelList: FilesCancelMessage = { requestId: 'r-1' };
    expect(ack.nextChunkIndex).toBe(3);
    expect(cancelTransfer.requestId).toBeUndefined();
    expect(cancelList.transferId).toBeUndefined();
  });

  it('round-trips every FilesErrorCode spelling', () => {
    const codes: FilesErrorCode[] = [
      'PATH_OUTSIDE_ROOT',
      'INVALID_PATH',
      'NOT_FOUND',
      'NOT_A_FILE',
      'NOT_A_DIRECTORY',
      'FILE_EXISTS',
      'FILE_TOO_LARGE',
      'TRANSFER_BUSY',
      'TRANSFER_UNKNOWN',
      'TRANSFER_TIMEOUT',
      'IO_ERROR',
      'BAD_FRAME',
    ];
    // A compile-time guard: the union must accept exactly these twelve.
    const seen = new Set<string>(codes);
    expect(seen.size).toBe(12);
    const err: FilesErrorMessage = {
      transferId: 't-1',
      code: 'BAD_FRAME',
      message: 'chunk gap',
    };
    expect(err.code).toBe('BAD_FRAME');
  });

  it('reuses the existing FileChunkMessage shape for chunks', () => {
    const chunk: FileChunkMessage = {
      transferId: 't-1',
      chunkIndex: 0,
      totalChunks: 1,
      data: 'AA==',
    };
    expect(chunk.chunkIndex).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/shared test file-types`
Expected: FAIL — `FilesListRequest`, `FilesErrorCode`, etc. are not exported from `../src` (TS2305 / unresolved named export).

- [ ] **Step 3: Append the types to `files.ts`**

Append to `packages/shared/src/types/files.ts` (below `FileChunkMessage`):

```typescript
/** Every wire path is POSIX-relative to the configured root; '' means the root itself. */
export type FilesPath = string;

export interface FilesListRequest {
  requestId: string;
  path: FilesPath;
}

export interface FilesListResult {
  requestId: string;
  path: FilesPath;
  entries: RemoteFile[]; // RemoteFile.path is the entry's full relative path
  truncated: boolean; // true when the directory exceeded MAX_LIST_ENTRIES
}

export interface FilesDownloadRequest {
  transferId: string;
  path: FilesPath; // must name a file
}

export interface FilesDownloadBegin {
  transferId: string;
  name: string; // basename
  path: FilesPath;
  size: number; // bytes
  totalChunks: number; // ceil(size / FILE_CHUNK_BYTES); 0 for an empty file
}

export interface FilesDownloadEnd {
  transferId: string;
}

export interface FilesUploadBeginRequest {
  transferId: string;
  path: FilesPath; // target DIRECTORY ('' = root); must exist
  name: string; // single path component; target = path + '/' + name
  size: number; // bytes, declared by the browser
}

export interface FilesUploadEndRequest {
  transferId: string;
}

export interface FilesUploadComplete {
  transferId: string;
  name: string;
  path: FilesPath; // full relative path of the written file
  size: number;
}

/** Cumulative flow-control ack, used in both directions. */
export interface FilesAckMessage {
  transferId: string;
  /** Count of CONTIGUOUS chunks received so far (0 before the first chunk). */
  nextChunkIndex: number;
}

export interface FilesCancelMessage {
  requestId?: string; // cancel a pending list
  transferId?: string; // cancel a transfer
}

export type FilesErrorCode =
  | 'PATH_OUTSIDE_ROOT'
  | 'INVALID_PATH'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'NOT_A_DIRECTORY'
  | 'FILE_EXISTS'
  | 'FILE_TOO_LARGE'
  | 'TRANSFER_BUSY'
  | 'TRANSFER_UNKNOWN'
  | 'TRANSFER_TIMEOUT'
  | 'IO_ERROR'
  | 'BAD_FRAME';

export interface FilesErrorMessage {
  requestId?: string; // set when the failure answers a list request
  transferId?: string; // set when the failure belongs to a transfer
  code: FilesErrorCode;
  message: string; // human-readable, never parsed
}
```

- [ ] **Step 4: Extend the barrel re-export**

In `packages/shared/src/types/index.ts:29-35` the block is:

```typescript
export type {
  TransferDirection,
  FileTransferStatus,
  RemoteFile,
  FileTransfer,
  FileChunkMessage,
} from './files.js';
```

Replace it with (all type-only — no value export):

```typescript
export type {
  TransferDirection,
  FileTransferStatus,
  RemoteFile,
  FileTransfer,
  FileChunkMessage,
  FilesPath,
  FilesListRequest,
  FilesListResult,
  FilesDownloadRequest,
  FilesDownloadBegin,
  FilesDownloadEnd,
  FilesUploadBeginRequest,
  FilesUploadEndRequest,
  FilesUploadComplete,
  FilesAckMessage,
  FilesCancelMessage,
  FilesErrorCode,
  FilesErrorMessage,
} from './files.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/shared test && pnpm --filter @ponter/shared typecheck`
Expected: PASS (the 5 existing files tests + the 6 new ones), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/files.ts packages/shared/src/types/index.ts packages/shared/test/file-types.test.ts
git commit -m "feat(shared): add file transfer wire types and FilesErrorCode"
```

---

### Task 2: `packages/file-core` — package scaffold + errors + transfer state machine (D2, part 1)

**Files:**
- Create: `packages/file-core/package.json`
- Create: `packages/file-core/tsconfig.json`
- Create: `packages/file-core/vitest.config.ts`
- Create: `packages/file-core/src/errors.ts`
- Create: `packages/file-core/src/transfer.ts`
- Create: `packages/file-core/test/transfer.test.ts`

**Interfaces:**
- Consumes: `FilesErrorCode`, `FilesAckMessage` (Task 1).
- Produces (relied on by **Tasks 3, 4, 8**):
  - `FileClientErrorCode = FilesErrorCode | 'CANCELLED'` (`errors.ts`)
  - `class FilesError extends Error { code; transferId? }` (`errors.ts`)
  - `FILE_CHUNK_BYTES = 32768`, `DEFAULT_WINDOW_SIZE = 16`, `DEFAULT_IDLE_TIMEOUT_MS = 30_000` (`transfer.ts`)
  - `totalChunksFor(size: number): number` — `ceil(size / 32768)`, `0` for `0`
  - `expectedChunkBytes(totalChunks: number, size: number, chunkIndex: number): number` — full `32768` except the final chunk = `size − (totalChunks−1) × 32768`
  - `class TransferState` — the shared window/ack/timer state machine with `sentCount`, `ackedCount`, `windowOpen`, `onAck`, `onChunkReceived`, `cancel`, `fail`, `succeed`, and a `settled` promise. Constructor: `new TransferState({ transferId, direction, totalChunks, size, windowSize, idleTimeoutMs, send, settle })`.

> **Why a separate `transfer.ts` first.** Both directions (download and upload) share one state machine (spec §5.2.5); Tasks 3 and 4 build `FileClient` on top of it. This task ships the package scaffold it needs (`package.json`/`tsconfig`/`vitest.config`) folded in — per the spec's §5.2 file list and `terminal-core`'s package shape (`packages/terminal-core/package.json:13-21`).

- [ ] **Step 1: Scaffold the package**

Create `packages/file-core/package.json`:

```json
{
  "name": "@ponter/file-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@ponter/shared": "workspace:*",
    "@ponter/webrtc-core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "24.19.0",
    "typescript": "6.0.3",
    "vitest": "5.0.3"
  }
}
```

Create `packages/file-core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM"],
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/file-core/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

Then run: `pnpm install`
Expected: the workspace links `@ponter/file-core`; `pnpm --filter @ponter/file-core test` runs vitest (no tests yet → vitest exits with "No test files found" — expected at this step).

- [ ] **Step 2: Write the failing tests for the state machine**

Create `packages/file-core/test/transfer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_WINDOW_SIZE,
  FILE_CHUNK_BYTES,
  TransferState,
  expectedChunkBytes,
  totalChunksFor,
} from '../src/transfer';
import { FilesError } from '../src/errors';

/** The send seam the client provides; records every frame the machine emits. */
function makeSend() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    send: vi.fn((frame: Record<string, unknown>) => {
      sent.push(frame);
    }),
  };
}

describe('chunk arithmetic (spec §2.5)', () => {
  it('pins the constants', () => {
    expect(FILE_CHUNK_BYTES).toBe(32768);
    expect(DEFAULT_WINDOW_SIZE).toBe(16);
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(30_000);
  });

  it('computes totalChunks with ceil and 0 for an empty file', () => {
    expect(totalChunksFor(0)).toBe(0);
    expect(totalChunksFor(32768)).toBe(1);
    expect(totalChunksFor(32769)).toBe(2);
    expect(totalChunksFor(600 * 1024)).toBe(19);
  });

  it('computes the expected byte length of each chunk', () => {
    expect(expectedChunkBytes(2, 32769, 0)).toBe(32768);
    expect(expectedChunkBytes(2, 32769, 1)).toBe(1);
    expect(expectedChunkBytes(1, 32768, 0)).toBe(32768);
  });
});

describe('TransferState window + acks (spec §2.4)', () => {
  let clock: ReturnType<typeof vi.useFakeTimers> | null = null;

  beforeEach(() => {
    clock = vi.useFakeTimers();
  });

  afterEach(() => {
    clock?.useRealTimers();
  });

  it('sends while sent - acked < windowSize and stops at the window', () => {
    const { sent, send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'upload',
      totalChunks: 20,
      size: 20 * FILE_CHUNK_BYTES,
      windowSize: 16,
      idleTimeoutMs: 30_000,
      send,
    });

    state.pump();

    expect(sent).toHaveLength(16);
    expect(sent.at(0)).toMatchObject({ chunkIndex: 0 });
    expect(sent.at(-1)).toMatchObject({ chunkIndex: 15 });
  });

  it('advances on a cumulative ack and ignores duplicate/regressive acks', () => {
    const { sent, send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'upload',
      totalChunks: 20,
      size: 20 * FILE_CHUNK_BYTES,
      windowSize: 16,
      idleTimeoutMs: 30_000,
      send,
    });

    state.pump();
    state.onAck(4); // cumulative: chunks 0..3 are in
    expect(sent).toHaveLength(20);

    state.onAck(4); // duplicate: ignored
    state.onAck(2); // regressive: ignored
    expect(state.ackedCount).toBe(4);
    expect(sent).toHaveLength(20);
  });

  it('fails with BAD_FRAME on an ack beyond what was sent', () => {
    const { send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'upload',
      totalChunks: 4,
      size: 4 * FILE_CHUNK_BYTES,
      windowSize: 16,
      idleTimeoutMs: 30_000,
      send,
    });

    state.pump();
    expect(() => state.onAck(5)).not.toThrow();
    expect(state.failure?.code).toBe('BAD_FRAME');
  });

  it('rejects the transfer with BAD_FRAME on a chunk gap', () => {
    const { send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'download',
      totalChunks: 3,
      size: 3 * FILE_CHUNK_BYTES,
      windowSize: 16,
      idleTimeoutMs: 30_000,
      send,
    });

    state.onChunkReceived(0, FILE_CHUNK_BYTES);
    state.onChunkReceived(2, FILE_CHUNK_BYTES); // gap: 1 never arrived
    expect(state.failure?.code).toBe('BAD_FRAME');
  });

  it('rejects a chunk whose decoded length disagrees with the declared size', () => {
    const { send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'download',
      totalChunks: 2,
      size: 32769,
      windowSize: 16,
      idleTimeoutMs: 30_000,
      send,
    });

    state.onChunkReceived(0, 32768);
    state.onChunkReceived(1, 5); // final chunk must be exactly 1 byte
    expect(state.failure?.code).toBe('BAD_FRAME');
  });

  it('fails with TRANSFER_TIMEOUT when no chunk or ack arrives within idleTimeoutMs', () => {
    const { send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'download',
      totalChunks: 2,
      size: 2 * FILE_CHUNK_BYTES,
      windowSize: 16,
      idleTimeoutMs: 1000,
      send,
    });

    state.armIdleTimer();
    vi.advanceTimersByTime(1001);

    expect(state.failure?.code).toBe('TRANSFER_TIMEOUT');
  });

  it('cancel() is idempotent and yields CANCELLED', () => {
    const { send } = makeSend();
    const state = new TransferState({
      transferId: 't-1',
      direction: 'upload',
      totalChunks: 4,
      size: 4 * FILE_CHUNK_BYTES,
      windowSize: 16,
      idleTimeoutMs: 30_000,
      send,
    });

    state.cancel();
    state.cancel();

    expect(state.failure?.code).toBe('CANCELLED');
    expect(state.settled).toBeInstanceOf(Promise);
    expect(send).toHaveBeenCalledTimes(1); // one files-cancel frame, not two
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @ponter/file-core test transfer`
Expected: FAIL — `../src/transfer` and `../src/errors` cannot be resolved.

- [ ] **Step 4: Implement `errors.ts`**

Create `packages/file-core/src/errors.ts`:

```typescript
import type { FilesErrorCode } from '@ponter/shared';

/**
 * Client-side codes: every wire code (spec §2.3) plus one synthetic code that
 * never appears on the wire — 'CANCELLED', raised locally by cancel()/dispose().
 */
export type FileClientErrorCode = FilesErrorCode | 'CANCELLED';

/** Error thrown/rejected by FileClient operations. */
export class FilesError extends Error {
  constructor(
    public readonly code: FileClientErrorCode,
    message: string,
    public readonly transferId?: string,
  ) {
    super(message);
    this.name = 'FilesError';
  }
}
```

- [ ] **Step 5: Implement `transfer.ts`**

Create `packages/file-core/src/transfer.ts`:

```typescript
import { FilesError, type FileClientErrorCode } from './errors';

/** Raw bytes per chunk (spec §2.5): 32 KiB → 43 692 base64 chars < 64 KiB. */
export const FILE_CHUNK_BYTES = 32768;

/** Sliding-window size in chunks (ADR-34). */
export const DEFAULT_WINDOW_SIZE = 16;

/** Idle timeout per transfer (ADR-34). */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** ceil(size / FILE_CHUNK_BYTES); 0 for an empty file (spec §2.5). */
export function totalChunksFor(size: number): number {
  return Math.ceil(size / FILE_CHUNK_BYTES);
}

/**
 * The byte length chunk `chunkIndex` must decode to (spec §2.4): every chunk
 * except the last is exactly FILE_CHUNK_BYTES; the last is the remainder.
 */
export function expectedChunkBytes(
  totalChunks: number,
  size: number,
  chunkIndex: number,
): number {
  if (chunkIndex < totalChunks - 1) return FILE_CHUNK_BYTES;
  return size - (totalChunks - 1) * FILE_CHUNK_BYTES;
}

export interface TransferStateOptions {
  transferId: string;
  direction: 'upload' | 'download';
  /** For an upload: derived from the local byte length. For a download: from files-download-begin. */
  totalChunks: number;
  /** Declared/known byte size — the single source of truth for chunk lengths. */
  size: number;
  windowSize: number;
  idleTimeoutMs: number;
  /** Emit one wire frame; the client supplies the type + payload building. */
  send: (frame: { type: string; payload: Record<string, unknown> }) => void;
}

/**
 * The window/ack/timer state machine shared by both directions (spec §5.2.5).
 *
 * The sender may send while `sentCount - ackedCount < windowSize` and
 * `sentCount < totalChunks`. Acks are cumulative counts of contiguous chunks;
 * duplicate/regressive acks are ignored, an ack beyond `sentCount` is BAD_FRAME.
 * On the receiving side, `onChunkReceived` validates contiguity and the
 * chunk-length rule, and answers with a cumulative ack via the client.
 */
export class TransferState {
  readonly transferId: string;
  readonly direction: 'upload' | 'download';
  readonly totalChunks: number;
  readonly size: number;

  sentCount = 0;
  ackedCount = 0;
  receivedCount = 0;
  failure: FilesError | null = null;

  private readonly windowSize: number;
  private readonly idleTimeoutMs: number;
  private readonly send: TransferStateOptions['send'];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private settlePromise: Promise<Uint8Array | void>;
  private settleResolve!: (value: Uint8Array | void) => void;
  private settleReject!: (error: FilesError) => void;
  private cancelSent = false;

  constructor(options: TransferStateOptions) {
    this.transferId = options.transferId;
    this.direction = options.direction;
    this.totalChunks = options.totalChunks;
    this.size = options.size;
    this.windowSize = options.windowSize;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.send = options.send;
    this.settlePromise = new Promise((resolve, reject) => {
      this.settleResolve = resolve;
      this.settleReject = reject;
    });
  }

  get settled(): Promise<Uint8Array | void> {
    return this.settlePromise;
  }

  get windowOpen(): boolean {
    return this.sentCount - this.ackedCount < this.windowSize;
  }

  /** Start (or restart) the idle timer; every chunk/ack resets it. */
  armIdleTimer(): void {
    if (this.failure) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.fail(new FilesError('TRANSFER_TIMEOUT', 'transfer idle timeout', this.transferId));
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** The send side: emit chunks while the window is open. */
  pump(): void {
    if (this.failure) return;
    while (this.windowOpen && this.sentCount < this.totalChunks) {
      const chunkIndex = this.sentCount;
      this.send({
        type: this.direction === 'upload' ? 'files-upload-chunk' : 'files-download-chunk',
        payload: { chunkIndex },
      });
      this.sentCount += 1;
    }
  }

  /** Validate one cumulative ack; ignored when duplicate/regressive. */
  onAck(nextChunkIndex: number): void {
    if (this.failure) return;
    if (nextChunkIndex > this.sentCount) {
      this.fail(new FilesError('BAD_FRAME', 'ack beyond sent chunks', this.transferId));
      return;
    }
    if (nextChunkIndex <= this.ackedCount) return;
    this.ackedCount = nextChunkIndex;
    this.armIdleTimer();
  }

  /** Validate one received chunk; returns false when it was rejected. */
  onChunkReceived(chunkIndex: number, decodedLength: number): boolean {
    if (this.failure) return false;
    if (chunkIndex !== this.receivedCount) {
      this.fail(new FilesError('BAD_FRAME', 'chunk gap', this.transferId));
      return false;
    }
    if (decodedLength !== expectedChunkBytes(this.totalChunks, this.size, chunkIndex)) {
      this.fail(new FilesError('BAD_FRAME', 'chunk length mismatch', this.transferId));
      return false;
    }
    this.receivedCount += 1;
    this.armIdleTimer();
    return true;
  }

  succeed(value?: Uint8Array): void {
    if (this.failure) return;
    this.clearIdleTimer();
    this.settleResolve(value);
  }

  fail(error: FilesError): void {
    if (this.failure) return;
    this.failure = error;
    this.clearIdleTimer();
    this.settleReject(error);
  }

  /** Idempotent: sends at most one files-cancel and rejects with CANCELLED. */
  cancel(): void {
    if (this.failure) return;
    if (!this.cancelSent) {
      this.cancelSent = true;
      this.send({ type: 'files-cancel', payload: { transferId: this.transferId } });
    }
    this.fail(new FilesError('CANCELLED', 'transfer cancelled', this.transferId));
  }

  /** Local teardown (dispose/disconnect): reject without a wire frame. */
  dispose(code: FileClientErrorCode = 'CANCELLED'): void {
    this.fail(new FilesError(code, 'transfer disposed', this.transferId));
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/file-core test transfer && pnpm --filter @ponter/file-core typecheck`
Expected: PASS (all tests), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/file-core/package.json packages/file-core/tsconfig.json packages/file-core/vitest.config.ts packages/file-core/src/errors.ts packages/file-core/src/transfer.ts packages/file-core/test/transfer.test.ts pnpm-lock.yaml
git commit -m "feat(file-core): scaffold package with transfer state machine and errors"
```

---

### Task 3: `packages/file-core` — `FileClient` (D2, part 2)

**Files:**
- Create: `packages/file-core/src/client.ts`
- Create: `packages/file-core/src/index.ts`
- Create: `packages/file-core/test/client.test.ts`

**Interfaces:**
- Consumes: `TransferState`, `totalChunksFor`, `expectedChunkBytes`, `FILE_CHUNK_BYTES`, `DEFAULT_WINDOW_SIZE`, `DEFAULT_IDLE_TIMEOUT_MS` (Task 2); `FilesError`, `FileClientErrorCode` (Task 2); `DataChannelManager` from `@ponter/webrtc-core`; wire types (Task 1).
- Produces (relied on by **Tasks 4, 8, 9**):
  - `FileListResult = Omit<FilesListResult, 'requestId'>`
  - `TransferProgress { transferId, direction, bytesTransferred, totalBytes, chunkIndex }`
  - `TransferHandle { transferId, direction, done, cancel() }`
  - `FileClientOptions { windowSize?, idleTimeoutMs? }`
  - `class FileClient { constructor(agentId, dataChannelManager, options?); list(path): Promise<FileListResult>; download(path, onProgress?): TransferHandle; upload(dirPath, name, bytes, onProgress?): TransferHandle; onError(handler): () => void; dispose(): void }`

> **Semantics (spec §5.2.1-5.2.7):** ids via `crypto.randomUUID()` with the `terminal-core` fallback (`packages/terminal-core/src/client.ts:70-73`); `list` resolves on the matching `files-list-result` and rejects on a matching `files-error`; `download` buffers chunks, acks each with the cumulative count, resolves on `files-download-end`; `upload` pumps chunks under the window, resolving on `files-upload-complete`; `dispose()` unsubscribes and rejects in-flight handles — it never closes the channel or the peer.

- [ ] **Step 1: Write the failing tests**

Create `packages/file-core/test/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileClient } from '../src/client';
import { FilesError } from '../src/errors';

interface FakeFrame {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * A fake DataChannelManager: captures `sendJson` calls and lets the test
 * replay agent frames through the registered `onMessage` handler.
 */
function makeFakeManager() {
  const sent: Array<FakeFrame & { label: string }> = [];
  let handler: ((msg: { type: string; channel: string; payload: unknown; timestamp: number }) => void) | null =
    null;
  const off = vi.fn();
  return {
    sent,
    off,
    manager: {
      sendJson: (label: string, type: string, payload: Record<string, unknown>) => {
        sent.push({ label, type, payload });
      },
      onMessage: (
        label: string,
        h: (msg: { type: string; channel: string; payload: unknown; timestamp: number }) => void,
      ) => {
        expect(label).toBe('files');
        handler = h;
        return off;
      },
    } as unknown as import('@ponter/webrtc-core').DataChannelManager,
    emit: (type: string, payload: Record<string, unknown>) => {
      handler?.({ type, channel: 'files', payload, timestamp: Date.now() });
    },
  };
}

describe('FileClient (spec §5.2)', () => {
  let fake: ReturnType<typeof makeFakeManager>;
  let client: FileClient;

  beforeEach(() => {
    fake = makeFakeManager();
    client = new FileClient('ag-1', fake.manager);
  });

  it('list resolves with the matching files-list-result and strips requestId', async () => {
    const promise = client.list('docs');
    const requestId = fake.sent.at(-1)?.payload.requestId as string;
    expect(fake.sent.at(-1)).toMatchObject({ label: 'files', type: 'files-list' });

    fake.emit('files-list-result', {
      requestId,
      path: 'docs',
      entries: [
        { name: 'a.txt', path: 'docs/a.txt', size: 3, isDirectory: false, modifiedAt: '2026-10-04T00:00:00Z' },
      ],
      truncated: false,
    });

    const result = await promise;
    expect(result.path).toBe('docs');
    expect(result.entries).toHaveLength(1);
    expect(result).not.toHaveProperty('requestId');
  });

  it('list rejects with the wire code on a matching files-error', async () => {
    const promise = client.list('nope');
    const requestId = fake.sent.at(-1)?.payload.requestId as string;
    fake.emit('files-error', { requestId, code: 'NOT_FOUND', message: 'no such dir' });

    await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('download assembles chunks, acks cumulatively and resolves on files-download-end', async () => {
    const progress: number[] = [];
    const handle = client.download('a.bin', (p) => progress.push(p.bytesTransferred));
    const transferId = fake.sent.at(-1)?.payload.transferId as string;
    expect(handle.transferId).toBe(transferId);

    fake.emit('files-download-begin', {
      transferId,
      name: 'a.bin',
      path: 'a.bin',
      size: 32769,
      totalChunks: 2,
    });
    const first = new Uint8Array(32768).fill(7);
    fake.emit('files-download-chunk', {
      transferId,
      chunkIndex: 0,
      totalChunks: 2,
      data: Buffer.from(first).toString('base64'),
    });
    fake.emit('files-download-chunk', {
      transferId,
      chunkIndex: 1,
      totalChunks: 2,
      data: Buffer.from(new Uint8Array([9])).toString('base64'),
    });
    fake.emit('files-download-end', { transferId });

    const bytes = (await handle.done) as Uint8Array;
    expect(bytes.length).toBe(32769);
    expect(bytes[0]).toBe(7);
    expect(bytes[32768]).toBe(9);

    const acks = fake.sent.filter((f) => f.type === 'files-download-ack');
    expect(acks.map((a) => a.payload.nextChunkIndex)).toEqual([1, 2]);
    expect(progress).toEqual([32768, 32769]);
  });

  it('download rejects the handle on a files-error for its id', async () => {
    const handle = client.download('a.bin');
    const transferId = fake.sent.at(-1)?.payload.transferId as string;
    fake.emit('files-error', { transferId, code: 'NOT_FOUND', message: 'gone' });

    await expect(handle.done).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('upload pumps chunks under the window and resumes on acks', async () => {
    const bytes = new Uint8Array(17 * 32768);
    const handle = client.upload('dir', 'big.bin', bytes, () => {});
    const transferId = fake.sent.at(-1)?.payload.transferId as string;

    fake.emit('files-upload-ack', { transferId, nextChunkIndex: 0 });
    let chunks = fake.sent.filter((f) => f.type === 'files-upload-chunk');
    expect(chunks).toHaveLength(16); // window filled

    fake.emit('files-upload-ack', { transferId, nextChunkIndex: 16 });
    chunks = fake.sent.filter((f) => f.type === 'files-upload-chunk');
    expect(chunks).toHaveLength(17); // resumed
    expect(fake.sent.filter((f) => f.type === 'files-upload-end')).toHaveLength(1);

    fake.emit('files-upload-complete', {
      transferId,
      name: 'big.bin',
      path: 'dir/big.bin',
      size: bytes.length,
    });
    await expect(handle.done).resolves.toBeUndefined();
  });

  it('upload rejects when the agent refuses at begin', async () => {
    const handle = client.upload('', 'x', new Uint8Array(1));
    const transferId = fake.sent.at(-1)?.payload.transferId as string;
    fake.emit('files-error', { transferId, code: 'FILE_EXISTS', message: 'exists' });

    await expect(handle.done).rejects.toMatchObject({ code: 'FILE_EXISTS' });
  });

  it('cancel() sends files-cancel and rejects with CANCELLED', async () => {
    const handle = client.download('a.bin');
    handle.cancel();
    handle.cancel();

    expect(fake.sent.filter((f) => f.type === 'files-cancel')).toHaveLength(1);
    await expect(handle.done).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('ignores frames for an unknown transferId and surfaces unsolicited errors via onError', async () => {
    const errors: Array<{ code: string; message: string }> = [];
    const off = client.onError((code, message) => errors.push({ code, message }));

    fake.emit('files-download-chunk', {
      transferId: 'nope',
      chunkIndex: 0,
      totalChunks: 1,
      data: '',
    });
    fake.emit('files-error', { code: 'TRANSFER_TIMEOUT', message: 'idle' });

    expect(errors).toEqual([{ code: 'TRANSFER_TIMEOUT', message: 'idle' }]);
    off();
  });

  it('dispose() rejects in-flight handles with CANCELLED and unsubscribes', async () => {
    const handle = client.download('a.bin');
    client.dispose();

    await expect(handle.done).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fake.off).toHaveBeenCalled();
    expect(() => client.list('')).toThrow(FilesError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/file-core test client`
Expected: FAIL — `../src/client` cannot be resolved.

- [ ] **Step 3: Implement `client.ts`**

Create `packages/file-core/src/client.ts`:

```typescript
import type { DataChannelManager } from '@ponter/webrtc-core';
import type {
  FilesAckMessage,
  FilesDownloadBegin,
  FilesDownloadEnd,
  FilesDownloadRequest,
  FilesErrorMessage,
  FilesListRequest,
  FilesListResult,
  FilesUploadBeginRequest,
  FilesUploadComplete,
  FilesUploadEndRequest,
  TransferDirection,
} from '@ponter/shared';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_WINDOW_SIZE,
  FILE_CHUNK_BYTES,
  TransferState,
  totalChunksFor,
} from './transfer';
import { FilesError, type FileClientErrorCode } from './errors';

/** The wire result minus the requestId the client consumed internally. */
export type FileListResult = Omit<FilesListResult, 'requestId'>;

export interface TransferProgress {
  transferId: string;
  direction: TransferDirection;
  bytesTransferred: number;
  totalBytes: number;
  /** Last contiguous chunk index (0-based; -1 before the first). */
  chunkIndex: number;
}

/** A handle returned by download()/upload(); progress via callbacks, abort via cancel(). */
export interface TransferHandle {
  readonly transferId: string;
  readonly direction: 'upload' | 'download';
  /** Resolves with the full payload (download: bytes; upload: nothing) or rejects with a FilesError. */
  readonly done: Promise<Uint8Array | void>;
  cancel(): void;
}

export interface FileClientOptions {
  /** Sliding-window size; default 16 (ADR-34). Test seam. */
  windowSize?: number;
  /** Idle timeout per transfer; default 30_000 ms (ADR-34). Test seam. */
  idleTimeoutMs?: number;
}

interface PendingList {
  resolve: (result: FileListResult) => void;
  reject: (error: FilesError) => void;
}

interface ActiveTransfer {
  state: TransferState;
  onProgress?: (progress: TransferProgress) => void;
  buffer: Uint8Array[];
  receivedBytes: number;
  declaredSize: number;
  /** True once files-upload-end has been sent (acks can still arrive after the last chunk). */
  ended?: boolean;
}

function mintId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)!;
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export class FileClient {
  private readonly pendingLists = new Map<string, PendingList>();
  private readonly transfers = new Map<string, ActiveTransfer>();
  private readonly errorListeners: Array<(code: FileClientErrorCode, message: string) => void> = [];
  private readonly unsubscribeMessage: () => void;
  private readonly windowSize: number;
  private readonly idleTimeoutMs: number;
  private disposed = false;

  constructor(
    public readonly agentId: string,
    private readonly dataChannelManager: DataChannelManager,
    options?: FileClientOptions,
  ) {
    this.windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.unsubscribeMessage = this.dataChannelManager.onMessage(
      'files',
      (msg) => this.handleMessage(msg as { type: string; payload: unknown }),
    );
  }

  /** List a directory. Rejects with FilesError. */
  list(path: string): Promise<FileListResult> {
    this.assertLive();
    const requestId = mintId();
    return new Promise<FileListResult>((resolve, reject) => {
      this.pendingLists.set(requestId, {
        resolve: (result) => resolve(result),
        reject,
      });
      const payload: FilesListRequest = { requestId, path };
      this.sendJson('files-list', payload);
    });
  }

  /** Download a file; `onProgress` fires per accepted chunk. */
  download(
    path: string,
    onProgress?: (progress: TransferProgress) => void,
  ): TransferHandle {
    this.assertLive();
    const transferId = mintId();
    const state = new TransferState({
      transferId,
      direction: 'download',
      // Replaced from files-download-begin; 0 until then (pump is receive-side anyway).
      totalChunks: 0,
      size: 0,
      windowSize: this.windowSize,
      idleTimeoutMs: this.idleTimeoutMs,
      send: (frame) => this.sendJson(frame.type, frame.payload),
    });
    const active: ActiveTransfer = {
      state,
      onProgress,
      buffer: [],
      receivedBytes: 0,
      declaredSize: 0,
    };
    this.transfers.set(transferId, active);
    state.armIdleTimer();
    this.sendJson('files-download', { transferId, path } as FilesDownloadRequest);
    return {
      transferId,
      direction: 'download',
      done: state.settled as Promise<Uint8Array | void>,
      cancel: () => state.cancel(),
    };
  }

  /** Upload bytes into `dirPath` under `name` (a single component). */
  upload(
    dirPath: string,
    name: string,
    bytes: Uint8Array,
    onProgress?: (progress: TransferProgress) => void,
  ): TransferHandle {
    this.assertLive();
    const transferId = mintId();
    const totalChunks = totalChunksFor(bytes.byteLength);
    const state = new TransferState({
      transferId,
      direction: 'upload',
      totalChunks,
      size: bytes.byteLength,
      windowSize: this.windowSize,
      idleTimeoutMs: this.idleTimeoutMs,
      send: (frame) => {
        if (frame.type === 'files-upload-chunk') {
          const chunkIndex = frame.payload.chunkIndex as number;
          const start = chunkIndex * FILE_CHUNK_BYTES;
          const slice = bytes.slice(start, start + FILE_CHUNK_BYTES);
          this.sendJson('files-upload-chunk', {
            transferId,
            chunkIndex,
            totalChunks,
            data: bytesToBase64(slice),
          });
          onProgress?.({
            transferId,
            direction: 'upload',
            bytesTransferred: Math.min((chunkIndex + 1) * FILE_CHUNK_BYTES, bytes.byteLength),
            totalBytes: bytes.byteLength,
            chunkIndex,
          });
          return;
        }
        this.sendJson(frame.type, { transferId, ...frame.payload });
      },
    });
    const active: ActiveTransfer = {
      state,
      onProgress,
      buffer: [],
      receivedBytes: 0,
      declaredSize: bytes.byteLength,
    };
    this.transfers.set(transferId, active);
    state.armIdleTimer();

    const begin: FilesUploadBeginRequest = {
      transferId,
      path: dirPath,
      name,
      size: bytes.byteLength,
    };
    this.sendJson('files-upload-begin', begin);
    return {
      transferId,
      direction: 'upload',
      done: state.settled as Promise<Uint8Array | void>,
      cancel: () => state.cancel(),
    };
  }

  /** Subscribe to unsolicited errors (e.g. TRANSFER_TIMEOUT); returns an unsubscribe. */
  onError(
    handler: (code: FileClientErrorCode, message: string) => void,
  ): () => void {
    this.errorListeners.push(handler);
    return () => {
      const idx = this.errorListeners.indexOf(handler);
      if (idx >= 0) this.errorListeners.splice(idx, 1);
    };
  }

  /** Unsubscribe and reject all in-flight transfers with 'CANCELLED'. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeMessage();
    for (const [, transfer] of this.transfers) {
      transfer.state.dispose('CANCELLED');
    }
    this.transfers.clear();
    for (const [, pending] of this.pendingLists) {
      pending.reject(new FilesError('CANCELLED', 'client disposed'));
    }
    this.pendingLists.clear();
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new FilesError('CANCELLED', 'client disposed');
    }
  }

  private sendJson(type: string, payload: Record<string, unknown> | object): void {
    this.dataChannelManager.sendJson('files', type, payload as Record<string, unknown>);
  }

  private handleMessage(msg: { type: string; payload: unknown }): void {
    switch (msg.type) {
      case 'files-list-result': {
        const payload = msg.payload as FilesListResult;
        const pending = this.pendingLists.get(payload.requestId);
        if (!pending) return;
        this.pendingLists.delete(payload.requestId);
        const { requestId: _ignored, ...rest } = payload;
        pending.resolve(rest);
        return;
      }
      case 'files-download-begin': {
        const payload = msg.payload as FilesDownloadBegin;
        const active = this.transfers.get(payload.transferId);
        if (!active) return;
        active.declaredSize = payload.size;
        active.onProgress?.({
          transferId: payload.transferId,
          direction: 'download',
          bytesTransferred: 0,
          totalBytes: payload.size,
          chunkIndex: -1,
        });
        return;
      }
      case 'files-download-chunk': {
        const payload = msg.payload as {
          transferId: string;
          chunkIndex: number;
          data: string;
        };
        const active = this.transfers.get(payload.transferId);
        if (!active) return;
        const bytes = base64ToBytes(payload.data);
        if (!active.state.onChunkReceived(payload.chunkIndex, bytes.byteLength)) return;
        active.buffer.push(bytes);
        active.receivedBytes += bytes.byteLength;
        this.sendJson('files-download-ack', {
          transferId: payload.transferId,
          nextChunkIndex: active.state.receivedCount,
        } satisfies FilesAckMessage);
        active.onProgress?.({
          transferId: payload.transferId,
          direction: 'download',
          bytesTransferred: active.receivedBytes,
          totalBytes: active.declaredSize,
          chunkIndex: payload.chunkIndex,
        });
        return;
      }
      case 'files-download-end': {
        const payload = msg.payload as FilesDownloadEnd;
        const active = this.transfers.get(payload.transferId);
        if (!active) return;
        this.transfers.delete(payload.transferId);
        const joined = new Uint8Array(active.receivedBytes);
        let offset = 0;
        for (const part of active.buffer) {
          joined.set(part, offset);
          offset += part.byteLength;
        }
        active.state.succeed(joined);
        return;
      }
      case 'files-upload-ack': {
        const payload = msg.payload as FilesAckMessage;
        const active = this.transfers.get(payload.transferId);
        if (!active) return;
        active.state.onAck(payload.nextChunkIndex);
        if (active.state.failure) return;
        active.state.pump();
        if (active.state.sentCount === active.state.totalChunks && !active.ended) {
          active.ended = true;
          this.sendJson('files-upload-end', {
            transferId: payload.transferId,
          } satisfies FilesUploadEndRequest);
        }
        return;
      }
      case 'files-upload-complete': {
        const payload = msg.payload as FilesUploadComplete;
        const active = this.transfers.get(payload.transferId);
        if (!active) return;
        this.transfers.delete(payload.transferId);
        active.state.succeed();
        return;
      }
      case 'files-error': {
        const payload = msg.payload as FilesErrorMessage;
        const error = new FilesError(payload.code, payload.message, payload.transferId);
        if (payload.transferId && this.transfers.has(payload.transferId)) {
          const active = this.transfers.get(payload.transferId)!;
          this.transfers.delete(payload.transferId);
          active.state.fail(error);
          return;
        }
        if (payload.requestId && this.pendingLists.has(payload.requestId)) {
          const pending = this.pendingLists.get(payload.requestId)!;
          this.pendingLists.delete(payload.requestId);
          pending.reject(error);
          return;
        }
        for (const listener of [...this.errorListeners]) {
          listener(payload.code, payload.message);
        }
        return;
      }
      default:
        return;
    }
  }
}
```

> **Two details the implementer must keep.** (1) The upload path calls `state.pump()` from `files-upload-ack`, but the **initial** pump for an upload happens on `files-upload-ack { nextChunkIndex: 0 }` — the agent's begin-ack — which is exactly what the test drives; do not pump before the first ack, because the agent has not accepted the begin yet. (2) `ActiveTransfer.ended` makes `files-upload-end` exactly-once: acks keep arriving for the last windowful after the final chunk is sent, so the `sentCount === totalChunks && !ended` check would otherwise re-send the end frame on every trailing ack.

- [ ] **Step 4: Create `index.ts`**

Create `packages/file-core/src/index.ts`:

```typescript
export * from './errors';
export * from './transfer';
export * from './client';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/file-core test && pnpm --filter @ponter/file-core typecheck`
Expected: PASS (transfer + client suites), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/file-core/src/client.ts packages/file-core/src/index.ts packages/file-core/test/client.test.ts
git commit -m "feat(file-core): add FileClient with list, download and upload"
```

---
### Task 4: Agent — `files.rs` wire layer, chunk math, and the sandbox `FilesRoot` (D3, part 1)

**Files:**
- Create: `apps/agent/src/files.rs` (constants, chunk arithmetic, RFC 3339 formatter, `FilesErrorCode`/`FilesError`, payload structs, `FilesInbound`/`Outbound`, `decode_files_frame`, `extract_ids`, `frame_files`, `FilesRoot`, tests)
- Modify: `apps/agent/src/main.rs:19-22` (register `mod files;` in the plain, **non**-musl-gated group: `mod logging; mod pty; mod rtc; mod signal;`)

**Interfaces:**
- Consumes: `crate::pty::{DataChannelMessage, MAX_FRAME_BYTES}` (`pty.rs:26`, `:37-45`); `tokio::fs` (tokio `features = ["full"]`, `apps/agent/Cargo.toml:21`); `serde`, `serde_json`, `base64` (already dependencies). **No new dependency** — the agent has no direct `time`/`chrono`/`uuid` crate, and must not gain one.
- Produces (relied on by **Tasks 6, 7**; do not rename):
  - `FILES_CHANNEL = "files"`; `FILE_CHUNK_BYTES: u64 = 32768`; `FILE_MAX_BYTES: u64 = 1 << 30`; `MAX_LIST_ENTRIES: usize = 4096`; `FILE_WINDOW_CHUNKS: u64 = 16`; `FILES_IDLE_TIMEOUT_MS: u64 = 30_000`; `FILES_IDLE_TIMEOUT: Duration` (30 s in production, **50 ms under `cfg(test)`** — spec §6.4 forbids a real 30 s sleep in tests)
  - `total_chunks(size: u64) -> u64`; `expected_chunk_len(total_chunks: u64, size: u64, chunk_index: u64) -> u64`
  - `FilesErrorCode` (12 variants; `as_str(&self) -> &'static str` pins the exact wire spellings); `FilesError { code, message, request_id: Option<String>, transfer_id: Option<String> }` (`Display`, `std::error::Error`); `type FilesResult<T> = std::result::Result<T, FilesError>`
  - Payload structs (all `pub`, `#[serde(rename_all = "camelCase")]`): `FilesListRequest`, `FilesListResult`, `RemoteFile`, `FilesDownloadRequest`, `FilesDownloadBegin`, `FilesDownloadEnd`, `FileChunkMessage`, `FilesUploadBeginRequest`, `FilesUploadEndRequest`, `FilesUploadComplete`, `FilesAckMessage`, `FilesCancelMessage`, `FilesErrorMessage`
  - `FilesInbound` (7 variants), `Outbound` (7 variants, `type_name()`); `decode_files_frame(raw: &str) -> anyhow::Result<Option<FilesInbound>>`; `extract_ids(raw: &str) -> (Option<String>, Option<String>)`; `frame_files(outbound: &Outbound, timestamp_ms: i64) -> String`
  - `rfc3339_utc(epoch_secs: u64) -> String`; `part_name(name: &str) -> String`
  - `FilesRoot { canonical: PathBuf }` with `resolve(raw: &str) -> FilesResult<Self>`, `resolve_existing(&self, wire: &str) -> FilesResult<PathBuf>`, `resolve_parent_for_create(&self, dir_wire: &str, name: &str) -> FilesResult<(PathBuf, String)>`, and `path(&self) -> &Path`

> **The module is NOT musl-gated (ADR-15 stays intact).** `files.rs` uses only `tokio::fs`/`std::fs` and serde, so it compiles on every target and the musl artifact serves files sessions. Register it as a plain `mod files;` in the `main.rs:19-22` group — **not** beside `mod desktop;`/`mod input;` (`:10-18`). The desktop musl stub (`main.rs:1539-1563`) is untouched.

> **Wire shapes are frozen (spec §2.2, §2.3).** Every frame is a `DataChannelMessage<T>` envelope (`pty.rs:37-45`): `{ type, channel: "files", payload, timestamp }`. Browser→agent types: `files-list`, `files-download`, `files-upload-begin`, `files-upload-chunk`, `files-upload-end`, `files-cancel`, `files-download-ack`. Agent→browser: `files-list-result`, `files-download-begin`, `files-download-chunk`, `files-download-end`, `files-upload-ack`, `files-upload-complete`, `files-error`. The chunk payload is `FileChunkMessage` in **both** directions.

> **The 12 error codes, exactly these spellings (spec §2.3).** `PATH_OUTSIDE_ROOT`, `INVALID_PATH`, `NOT_FOUND`, `NOT_A_FILE`, `NOT_A_DIRECTORY`, `FILE_EXISTS`, `FILE_TOO_LARGE`, `TRANSFER_BUSY`, `TRANSFER_UNKNOWN`, `TRANSFER_TIMEOUT`, `IO_ERROR`, `BAD_FRAME`.

> **Reading order for this task:** it is the largest single file in the plan. Step 1 writes the full failing test module first; Step 3 fills in the module head — imports, constants, chunk arithmetic, the RFC 3339 formatter, `FilesErrorCode`/`FilesError` and its constructors, the payload structs, `FilesInbound`/`Outbound`, `decode_files_frame`, `extract_ids`, `frame_files`, then the sandbox (`FilesRoot`). The two test call sites that use `root.path()` (the `path_policy_rejects_empty_components_and_dots` and `upload_create_path_validates_parent_and_name` tests) compile against the temporary `path()` accessor; **Task 7 Step 6 deletes that accessor and rewrites both call sites** to use the raw `dir` handle they already hold. Do not "fix" them here — the accessor is live until Task 7.

- [ ] **Step 1: Register the module and write the failing tests**

In `apps/agent/src/main.rs`, the plain module group at `:19-22` is:

```rust
mod logging;
mod pty;
mod rtc;
mod signal;
```

Add `files` to that group (alphabetical, before `logging`). `apps/agent` is a **binary** crate, so until Task 7's dispatch consumes these items every `pub` in the module is dead code to clippy `--all-targets -D warnings` (test-only use does not count for the bin target) — the temporary allow is what keeps this task's own clippy step green:

```rust
// Consumed by the files dispatch in Task 7; until then clippy's `dead_code`
// flags the wire layer (a binary crate has no library root, and test-only
// uses do not count). Removed in Task 7.
#[allow(dead_code)]
mod files;
mod logging;
mod pty;
mod rtc;
mod signal;
```

Then create `apps/agent/src/files.rs` containing **only** the tests below (they reference items that do not exist yet — that compile failure is the red state).

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Unique temp dir under `std::env::temp_dir()` (spec §6.4: pid + a
    /// monotonic counter; no new dependency). Callers remove it at the end.
    fn temp_dir_for_test() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("ponter-files-test-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Build one `files` envelope around a payload (mirrors the browser shape).
    fn envelope(ty: &str, payload: serde_json::Value) -> String {
        serde_json::json!({
            "type": ty,
            "channel": "files",
            "payload": payload,
            "timestamp": 0,
        })
        .to_string()
    }

    /// A `files-list` frame for the decode tests.
    fn list_frame() -> String {
        envelope("files-list", serde_json::json!({ "requestId": "r-1", "path": "" }))
    }

    #[test]
    fn total_chunks_matches_the_spec_arithmetic() {
        // §2.5: ceil(size / 32768), with 0 for an empty file.
        assert_eq!(total_chunks(0), 0);
        assert_eq!(total_chunks(32768), 1);
        assert_eq!(total_chunks(32769), 2);
        assert_eq!(total_chunks(600 * 1024), 19);
    }

    #[test]
    fn expected_chunk_len_is_full_except_the_last() {
        assert_eq!(expected_chunk_len(2, 32769, 0), 32768);
        assert_eq!(expected_chunk_len(2, 32769, 1), 1);
        assert_eq!(expected_chunk_len(1, 32768, 0), 32768);
    }

    #[test]
    fn chunk_base64_plus_envelope_stays_under_the_frame_cap() {
        // ADR-34: 32 KiB raw → 43 692 base64 chars; the framed JSON must stay
        // under MAX_FRAME_BYTES (the inbound guard checked before serde).
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 32768]);
        assert_eq!(encoded.len(), 43692);
        let frame = frame_files(
            &Outbound::DownloadChunk(FileChunkMessage {
                transfer_id: "t-1".to_string(),
                chunk_index: 0,
                total_chunks: 1,
                data: encoded,
            }),
            0,
        );
        assert!(frame.len() < crate::pty::MAX_FRAME_BYTES);
    }

    #[test]
    fn error_code_spellings_are_pinned() {
        // The spellings are a wire contract — the browser switches on them.
        let cases = [
            (FilesErrorCode::PathOutsideRoot, "PATH_OUTSIDE_ROOT"),
            (FilesErrorCode::InvalidPath, "INVALID_PATH"),
            (FilesErrorCode::NotFound, "NOT_FOUND"),
            (FilesErrorCode::NotAFile, "NOT_A_FILE"),
            (FilesErrorCode::NotADirectory, "NOT_A_DIRECTORY"),
            (FilesErrorCode::FileExists, "FILE_EXISTS"),
            (FilesErrorCode::FileTooLarge, "FILE_TOO_LARGE"),
            (FilesErrorCode::TransferBusy, "TRANSFER_BUSY"),
            (FilesErrorCode::TransferUnknown, "TRANSFER_UNKNOWN"),
            (FilesErrorCode::TransferTimeout, "TRANSFER_TIMEOUT"),
            (FilesErrorCode::IoError, "IO_ERROR"),
            (FilesErrorCode::BadFrame, "BAD_FRAME"),
        ];
        assert_eq!(cases.len(), 12);
        for (code, spelling) in cases {
            assert_eq!(code.as_str(), spelling);
        }
    }

    #[test]
    fn rfc3339_formats_epoch_seconds_utc() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(rfc3339_utc(1_791_072_000), "2026-10-04T00:00:00Z");
        assert_eq!(rfc3339_utc(86_399), "1970-01-01T23:59:59Z");
    }

    #[test]
    fn decode_guard_never_errors_on_foreign_frames() {
        // Wrong channel → Ok(None): ADR-09 means the agent ignores other labels.
        let wrong_channel = serde_json::json!({
            "type": "files-list",
            "channel": "terminal",
            "payload": { "requestId": "r-1", "path": "" },
            "timestamp": 0,
        })
        .to_string();
        assert_eq!(decode_files_frame(&wrong_channel).unwrap(), None);

        // Wrong type → Ok(None).
        let wrong_type = envelope("files-nope", serde_json::json!({ "requestId": "r-1" }));
        assert_eq!(decode_files_frame(&wrong_type).unwrap(), None);

        // Oversize → Err BEFORE parsing (the payload is not even valid JSON).
        let huge = format!("{{\\"type\\": \\"x\\", \\"pad\\": \\"{}\\"}}", "x".repeat(crate::pty::MAX_FRAME_BYTES));
        assert!(decode_files_frame(&huge).is_err());

        // Malformed JSON → Err.
        assert!(decode_files_frame("{not json").is_err());
    }

    #[test]
    fn decode_guard_extracts_ids_for_attribution() {
        let (request_id, transfer_id) = extract_ids(&list_frame());
        assert_eq!(request_id.as_deref(), Some("r-1"));
        assert_eq!(transfer_id, None);

        let download = envelope("files-download", serde_json::json!({ "transferId": "t-9", "path": "a.bin" }));
        let (request_id, transfer_id) = extract_ids(&download);
        assert_eq!(request_id, None);
        assert_eq!(transfer_id.as_deref(), Some("t-9"));

        // Garbage in → (None, None), never a panic.
        assert_eq!(extract_ids("{not json"), (None, None));
    }

    #[test]
    fn decode_round_trips_every_browser_to_agent_type() {
        let list = decode_files_frame(&list_frame()).unwrap().unwrap();
        assert!(matches!(list, FilesInbound::List(ref l) if l.request_id == "r-1"));

        let download = envelope("files-download", serde_json::json!({ "transferId": "t-1", "path": "a.bin" }));
        assert!(matches!(decode_files_frame(&download).unwrap().unwrap(), FilesInbound::Download(ref d) if d.transfer_id == "t-1"));

        let begin = envelope("files-upload-begin", serde_json::json!({ "transferId": "t-2", "path": "dir", "name": "up.bin", "size": 5 }));
        assert!(matches!(decode_files_frame(&begin).unwrap().unwrap(), FilesInbound::UploadBegin(ref b) if b.name == "up.bin" && b.size == 5));

        let chunk = envelope("files-upload-chunk", serde_json::json!({ "transferId": "t-2", "chunkIndex": 0, "totalChunks": 1, "data": "AA==" }));
        assert!(matches!(decode_files_frame(&chunk).unwrap().unwrap(), FilesInbound::UploadChunk(ref c) if c.chunk_index == 0));

        let end = envelope("files-upload-end", serde_json::json!({ "transferId": "t-2" }));
        assert!(matches!(decode_files_frame(&end).unwrap().unwrap(), FilesInbound::UploadEnd(ref e) if e.transfer_id == "t-2"));

        let cancel = envelope("files-cancel", serde_json::json!({ "transferId": "t-2" }));
        assert!(matches!(decode_files_frame(&cancel).unwrap().unwrap(), FilesInbound::Cancel(ref c) if c.transfer_id.as_deref() == Some("t-2")));

        let ack = envelope("files-download-ack", serde_json::json!({ "transferId": "t-1", "nextChunkIndex": 3 }));
        assert!(matches!(decode_files_frame(&ack).unwrap().unwrap(), FilesInbound::DownloadAck(ref a) if a.next_chunk_index == 3));
    }

    #[test]
    fn frame_files_wraps_the_envelope() {
        let frame = frame_files(
            &Outbound::ListResult(FilesListResult {
                request_id: "r-1".to_string(),
                path: "docs".to_string(),
                entries: vec![],
                truncated: false,
            }),
            7,
        );
        let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(value["type"], "files-list-result");
        assert_eq!(value["channel"], "files");
        assert_eq!(value["payload"]["requestId"], "r-1");
        assert_eq!(value["payload"]["truncated"], false);
        assert_eq!(value["timestamp"], 7);
    }

    #[test]
    fn error_frames_carry_the_code_and_attribution() {
        let error = FilesError::new(FilesErrorCode::BadFrame, "chunk gap").with_ids(None, Some("t-1".to_string()));
        let frame = frame_files(&Outbound::Error(error), 0);
        let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(value["type"], "files-error");
        assert_eq!(value["payload"]["code"], "BAD_FRAME");
        assert_eq!(value["payload"]["transferId"], "t-1");
        assert_eq!(value["payload"]["message"], "chunk gap");
    }

    // ---- path policy (ADR-33): one test per row of spec §6.4 ----

    #[tokio::test]
    #[cfg(unix)]
    async fn path_policy_rejects_dotdot_escape() {
        // `..` is NOT rejected syntactically: it flows to canonicalize and the
        // prefix check is what rejects the escape (spec §6.4's row expects
        // PATH_OUTSIDE_ROOT, not INVALID_PATH). `a/../..` resolves to the
        // parent of the root, which exists on any Unix.
        let dir = temp_dir_for_test();
        std::fs::create_dir(dir.join("a")).unwrap();
        let root = FilesRoot::resolve(dir.to_str().unwrap()).await.unwrap();
        let err = root.resolve_existing("a/../..").await.unwrap_err();
        assert_eq!(err.code, FilesErrorCode::PathOutsideRoot);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn path_policy_rejects_absolute() {
        let dir = temp_dir_for_test();
        let root = FilesRoot::resolve(dir.to_str().unwrap()).await.unwrap();
        let err = root.resolve_existing("/etc/passwd").await.unwrap_err();
        assert_eq!(err.code, FilesErrorCode::InvalidPath);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn path_policy_rejects_empty_components_and_dots() {
        let dir = temp_dir_for_test();
        let root = FilesRoot::resolve(dir.to_str().unwrap()).await.unwrap();
        std::fs::create_dir(root.path().join("a")).unwrap();
        for wire in ["a//b", "a/./b", "./a", "a/"] {
            let err = root.resolve_existing(wire).await.unwrap_err();
            assert_eq!(err.code, FilesErrorCode::InvalidPath, "wire: {wire}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn path_policy_rejects_symlink_escape() {
        let dir = temp_dir_for_test();
        let outside = temp_dir_for_test();
        std::fs::write(outside.join("secret.txt"), b"x").unwrap();
        // Symlink creation is Unix-only; on other targets the policy is still
        // compile-checked and the rest of this test is a no-op.
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
        #[cfg(unix)]
        {
            let root = FilesRoot::resolve(dir.to_str().unwrap()).await.unwrap();
            let err = root.resolve_existing("link/secret.txt").await.unwrap_err();
            assert_eq!(err.code, FilesErrorCode::PathOutsideRoot);
        }
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[tokio::test]
    async fn path_policy_rejects_prefix_confusion() {
        // root `<base>/files` must not admit the sibling `<base>/files2`; the
        // check is `canonical == root || canonical.starts_with(root + sep)`.
        // `../files2` reaches the sibling without a symlink, so this test runs
        // on every OS (the target exists, so canonicalize succeeds).
        let base = temp_dir_for_test();
        let root_dir = base.join("files");
        let sibling = base.join("files2");
        std::fs::create_dir_all(&root_dir).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("x"), b"x").unwrap();

        let root = FilesRoot::resolve(root_dir.to_str().unwrap()).await.unwrap();
        let err = root.resolve_existing("../files2/x").await.unwrap_err();
        assert_eq!(err.code, FilesErrorCode::PathOutsideRoot);
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn upload_create_path_validates_parent_and_name() {
        let dir = temp_dir_for_test();
        std::fs::create_dir(dir.join("dir")).unwrap();
        let root = FilesRoot::resolve(dir.to_str().unwrap()).await.unwrap();

        let (parent, name) = root.resolve_parent_for_create("dir", "name.txt").await.unwrap();
        assert_eq!(parent, root.path().join("dir").canonicalize().unwrap());
        assert_eq!(name, "name.txt");

        for bad in ["../x", "a/b", "..", "."] {
            let err = root.resolve_parent_for_create("dir", bad).await.unwrap_err();
            assert_eq!(err.code, FilesErrorCode::InvalidPath, "name: {bad}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn root_resolution_fails_when_missing_not_a_dir_or_unreadable() {
        // Missing path.
        let missing = std::env::temp_dir().join(format!("ponter-files-missing-{}", std::process::id()));
        assert_eq!(
            FilesRoot::resolve(missing.to_str().unwrap()).await.unwrap_err().code,
            FilesErrorCode::NotFound
        );

        // A file is not a directory.
        let dir = temp_dir_for_test();
        let file = dir.join("plain.txt");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(
            FilesRoot::resolve(file.to_str().unwrap()).await.unwrap_err().code,
            FilesErrorCode::NotADirectory
        );

        // Unreadable (mode 000) — Unix only, and skipped when running as root
        // (root ignores permission bits, so the probe would be a false pass).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = dir.join("locked");
            std::fs::create_dir(&locked).unwrap();
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
            let probe = std::fs::read_dir(&locked);
            if probe.is_ok() {
                // Running as root: the permission probe cannot fail here.
            } else {
                assert_eq!(
                    FilesRoot::resolve(locked.to_str().unwrap()).await.unwrap_err().code,
                    FilesErrorCode::IoError
                );
            }
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).ok();
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked files::`
Expected: FAIL to compile — `files` module items (`total_chunks`, `FilesRoot`, `decode_files_frame`, …) do not exist. (`mod files;` on an empty file compiles, so write the test module first; the errors name the missing items.)

- [ ] **Step 3: Implement the constants, the error type, the payloads, the decoder, and the framer**

Replace the placeholder with the module head — doc comment, imports, constants, arithmetic, the formatter, the error type, the payloads, `FilesInbound`/`Outbound`, `decode_files_frame`, `extract_ids`, `frame_files` — then **keep the tests at the bottom** (move the `#[cfg(test)] mod tests` block from Step 1 down, unchanged):

```rust
//! File transfer over the `files` data channel (Week 10, spec §6.1).
//!
//! Two halves: the wire layer (decode/frame, chunk arithmetic, error codes)
//! and the sandbox (`FilesRoot`). The session state machine that uses both
//! lives in Task 6. **Not musl-gated**: this module uses only `tokio::fs`/
//! `std::fs` and serde, so the musl artifact serves files sessions too.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result as AnyhowResult};
use serde::{Deserialize, Serialize};

/// The one channel label this module speaks (ADR-31).
pub const FILES_CHANNEL: &str = "files";

/// Raw bytes per chunk (ADR-34): 32 KiB → 43 692 base64 chars ≈ 43.8 KB
/// framed, under `MAX_FRAME_BYTES` (64 KiB).
pub const FILE_CHUNK_BYTES: u64 = 32768;

/// The per-file cap, enforced on the declared/stat size (spec §2.5).
pub const FILE_MAX_BYTES: u64 = 1 << 30; // 1 GiB

/// The list cap (spec §2.5): first 4096 entries, sorted, with `truncated`.
pub const MAX_LIST_ENTRIES: usize = 4096;

/// Sliding-window size in chunks, both directions (ADR-34).
pub const FILE_WINDOW_CHUNKS: u64 = 16;

/// Idle timeout per transfer (ADR-34): 30 s in production.
pub const FILES_IDLE_TIMEOUT_MS: u64 = 30_000;

/// The idle timeout as a `Duration`. **Shrunk under `cfg(test)`** so unit
/// tests never sleep 30 s real time (spec §6.4); the wire value stays pinned
/// by [`FILES_IDLE_TIMEOUT_MS`] and its own assertion.
#[cfg(not(test))]
pub const FILES_IDLE_TIMEOUT: Duration = Duration::from_millis(FILES_IDLE_TIMEOUT_MS);
#[cfg(test)]
pub const FILES_IDLE_TIMEOUT: Duration = Duration::from_millis(50);

/// `ceil(size / FILE_CHUNK_BYTES)`; `0` for an empty file (spec §2.5).
pub fn total_chunks(size: u64) -> u64 {
    size.div_ceil(FILE_CHUNK_BYTES)
}

/// The byte length chunk `chunk_index` must decode to (spec §2.4): every chunk
/// except the last is exactly `FILE_CHUNK_BYTES`; the last is the remainder.
pub fn expected_chunk_len(total_chunks: u64, size: u64, chunk_index: u64) -> u64 {
    if chunk_index + 1 < total_chunks {
        FILE_CHUNK_BYTES
    } else {
        size - total_chunks.saturating_sub(1) * FILE_CHUNK_BYTES
    }
}

/// The upload temp-file suffix (ADR-33): the final name must never appear
/// half-written. Single source of truth for create/remove/find.
pub const PART_SUFFIX: &str = ".ponter-part";

/// The sibling temp name for an upload of `name`.
pub fn part_name(name: &str) -> String {
    format!("{name}{PART_SUFFIX}")
}

/// Format epoch seconds as an RFC 3339 UTC string (`2026-10-04T12:00:00Z`).
///
/// Std-only — the agent has no `time`/`chrono` dependency and must not gain
/// one for one field (spec §6.1). Valid for every `u64` we can produce from
/// `SystemTime` on this machine; the civil-date math is Hinnant's
/// `civil_from_days`, exact for all non-negative epoch seconds.
pub fn rfc3339_utc(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let secs_of_day = epoch_secs % 86_400;
    // days_from_civil, shifted to days since 0000-03-01.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    )
}

/// The wire codes of spec §2.3. The spellings are a wire contract; `as_str`
/// pins them (mirrors `PtyErrorCode`, `pty.rs:53-66`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilesErrorCode {
    PathOutsideRoot,
    InvalidPath,
    NotFound,
    NotAFile,
    NotADirectory,
    FileExists,
    FileTooLarge,
    TransferBusy,
    TransferUnknown,
    TransferTimeout,
    IoError,
    BadFrame,
}

impl FilesErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PathOutsideRoot => "PATH_OUTSIDE_ROOT",
            Self::InvalidPath => "INVALID_PATH",
            Self::NotFound => "NOT_FOUND",
            Self::NotAFile => "NOT_A_FILE",
            Self::NotADirectory => "NOT_A_DIRECTORY",
            Self::FileExists => "FILE_EXISTS",
            Self::FileTooLarge => "FILE_TOO_LARGE",
            Self::TransferBusy => "TRANSFER_BUSY",
            Self::TransferUnknown => "TRANSFER_UNKNOWN",
            Self::TransferTimeout => "TRANSFER_TIMEOUT",
            Self::IoError => "IO_ERROR",
            Self::BadFrame => "BAD_FRAME",
        }
    }
}

/// One files failure, on the wire (`files-error`) or inside the state machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilesError {
    pub code: FilesErrorCode,
    pub message: String,
    /// `Some` when the failure answers a list request.
    pub request_id: Option<String>,
    /// `Some` when the failure belongs to a transfer.
    pub transfer_id: Option<String>,
}

impl FilesError {
    pub fn new(code: FilesErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), request_id: None, transfer_id: None }
    }

    /// Attach the ids the failure belongs to (builder style).
    pub fn with_ids(mut self, request_id: Option<String>, transfer_id: Option<String>) -> Self {
        self.request_id = request_id;
        self.transfer_id = transfer_id;
        self
    }

    pub fn invalid_path(message: impl Into<String>) -> Self {
        Self::new(FilesErrorCode::InvalidPath, message)
    }

    pub fn outside_root() -> Self {
        Self::new(FilesErrorCode::PathOutsideRoot, "path escapes the configured root")
    }

    pub fn not_found() -> Self {
        Self::new(FilesErrorCode::NotFound, "no such file or directory")
    }

    pub fn not_a_directory() -> Self {
        Self::new(FilesErrorCode::NotADirectory, "not a directory")
    }

    /// Map a filesystem error onto the wire code (everything else is IO_ERROR).
    pub fn io(context: &str, error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => FilesErrorCode::NotFound,
            _ => FilesErrorCode::IoError,
        };
        Self::new(code, format!("{context}: {error}"))
    }
}

impl std::fmt::Display for FilesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for FilesError {}

pub type FilesResult<T> = std::result::Result<T, FilesError>;

// ---- payloads (spec §2.3; camelCase on the wire) ----

/// One directory entry. `path` is the entry's full relative path (spec §2.3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
    pub modified_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesListRequest {
    pub request_id: String,
    /// POSIX-relative; `""` = the root itself.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesListResult {
    pub request_id: String,
    pub path: String,
    pub entries: Vec<RemoteFile>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesDownloadRequest {
    pub transfer_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesDownloadBegin {
    pub transfer_id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub total_chunks: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesDownloadEnd {
    pub transfer_id: String,
}

/// The chunk payload, both directions (spec §2.2): base64 raw bytes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChunkMessage {
    pub transfer_id: String,
    pub chunk_index: u64,
    pub total_chunks: u64,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesUploadBeginRequest {
    pub transfer_id: String,
    /// Target DIRECTORY (`""` = root); must exist.
    pub path: String,
    /// Single path component; target = `path + '/' + name`.
    pub name: String,
    /// Bytes, declared by the browser.
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesUploadEndRequest {
    pub transfer_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesUploadComplete {
    pub transfer_id: String,
    pub name: String,
    /// Full relative path of the written file.
    pub path: String,
    pub size: u64,
}

/// Cumulative flow-control ack, used in both directions (spec §2.4).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesAckMessage {
    pub transfer_id: String,
    /// Count of CONTIGUOUS chunks received so far (0 before the first chunk).
    pub next_chunk_index: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesCancelMessage {
    pub request_id: Option<String>,
    pub transfer_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesErrorMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_id: Option<String>,
    pub code: String,
    pub message: String,
}

impl FilesErrorMessage {
    pub fn from_error(error: &FilesError) -> Self {
        Self {
            request_id: error.request_id.clone(),
            transfer_id: error.transfer_id.clone(),
            code: error.code.as_str().to_string(),
            message: error.message.clone(),
        }
    }
}

/// One decoded inbound frame (browser → agent).
#[derive(Debug, Clone, PartialEq)]
pub enum FilesInbound {
    List(FilesListRequest),
    Download(FilesDownloadRequest),
    UploadBegin(FilesUploadBeginRequest),
    UploadChunk(FileChunkMessage),
    UploadEnd(FilesUploadEndRequest),
    Cancel(FilesCancelMessage),
    DownloadAck(FilesAckMessage),
}

/// One outbound frame (agent → browser), framed by [`frame_files`].
#[derive(Debug, Clone, PartialEq)]
pub enum Outbound {
    ListResult(FilesListResult),
    DownloadBegin(FilesDownloadBegin),
    DownloadChunk(FileChunkMessage),
    DownloadEnd(FilesDownloadEnd),
    UploadAck(FilesAckMessage),
    UploadComplete(FilesUploadComplete),
    Error(FilesErrorMessage),
}

impl Outbound {
    /// The wire `type` string, for logging and assertions.
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::ListResult(_) => "files-list-result",
            Self::DownloadBegin(_) => "files-download-begin",
            Self::DownloadChunk(_) => "files-download-chunk",
            Self::DownloadEnd(_) => "files-download-end",
            Self::UploadAck(_) => "files-upload-ack",
            Self::UploadComplete(_) => "files-upload-complete",
            Self::Error(_) => "files-error",
        }
    }
}

/// Decode an inbound frame; same guard shape as `decode_pty_input`
/// (`pty.rs:124-144`): the size cap is checked **before** `serde_json` parses,
/// the channel/type match is strict, and a non-matching frame is `Ok(None)`.
///
/// `Err` means the frame claimed to be a files frame and could not be decoded
/// (→ `BAD_FRAME` by the caller, never fatal). Unknown *types* are `Ok(None)`
/// (warn-and-ignore, spec §2.2) — only the seven known types decode.
pub fn decode_files_frame(raw: &str) -> AnyhowResult<Option<FilesInbound>> {
    if raw.len() > crate::pty::MAX_FRAME_BYTES {
        anyhow::bail!("inbound frame exceeds {} bytes", crate::pty::MAX_FRAME_BYTES);
    }

    let envelope: crate::pty::DataChannelMessage<serde_json::Value> =
        serde_json::from_str(raw).context("inbound frame is not a DataChannelMessage")?;

    if envelope.channel != FILES_CHANNEL {
        return Ok(None);
    }

    let payload = envelope.payload;
    let inbound = match envelope.r#type.as_str() {
        "files-list" => FilesInbound::List(
            serde_json::from_value(payload).context("payload is not a FilesListRequest")?,
        ),
        "files-download" => FilesInbound::Download(
            serde_json::from_value(payload).context("payload is not a FilesDownloadRequest")?,
        ),
        "files-upload-begin" => FilesInbound::UploadBegin(
            serde_json::from_value(payload).context("payload is not a FilesUploadBeginRequest")?,
        ),
        "files-upload-chunk" => FilesInbound::UploadChunk(
            serde_json::from_value(payload).context("payload is not a FileChunkMessage")?,
        ),
        "files-upload-end" => FilesInbound::UploadEnd(
            serde_json::from_value(payload).context("payload is not a FilesUploadEndRequest")?,
        ),
        "files-cancel" => FilesInbound::Cancel(
            serde_json::from_value(payload).context("payload is not a FilesCancelMessage")?,
        ),
        "files-download-ack" => FilesInbound::DownloadAck(
            serde_json::from_value(payload).context("payload is not a FilesAckMessage")?,
        ),
        _ => return Ok(None),
    };

    Ok(Some(inbound))
}

/// Best-effort id extraction for attributing a `BAD_FRAME` to its request or
/// transfer (spec §2.6: "with the id, when extractable"). Never fails.
pub fn extract_ids(raw: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return (None, None);
    };
    let payload = &value["payload"];
    let request_id = payload["requestId"].as_str().map(str::to_string);
    let transfer_id = payload["transferId"].as_str().map(str::to_string);
    (request_id, transfer_id)
}

/// Frame one outbound message as a `DataChannelMessage` JSON string.
///
/// `timestamp_ms` is passed in (like `pty::frame_pty_output`) so the framing
/// stays pure and testable; callers pass `crate::pty::now_ms()`.
pub fn frame_files(outbound: &Outbound, timestamp_ms: i64) -> String {
    let (r#type, payload) = match outbound {
        Outbound::ListResult(p) => ("files-list-result", serde_json::to_value(p)),
        Outbound::DownloadBegin(p) => ("files-download-begin", serde_json::to_value(p)),
        Outbound::DownloadChunk(p) => ("files-download-chunk", serde_json::to_value(p)),
        Outbound::DownloadEnd(p) => ("files-download-end", serde_json::to_value(p)),
        Outbound::UploadAck(p) => ("files-upload-ack", serde_json::to_value(p)),
        Outbound::UploadComplete(p) => ("files-upload-complete", serde_json::to_value(p)),
        Outbound::Error(p) => ("files-error", serde_json::to_value(p)),
    };
    let message = crate::pty::DataChannelMessage {
        r#type: r#type.to_string(),
        channel: FILES_CHANNEL.to_string(),
        payload: payload.expect("files payloads are plain data and cannot fail to serialize"),
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("a frame of plain data cannot fail to serialize")
}

// ---- the sandbox (ADR-33) ----

/// One configured sandbox root, canonicalized once per session.
///
/// The gate resolves this per offer (ADR-32); a `FilesRoot` exists only when
/// the operator pointed the agent at a real, readable directory. Every wire
/// path goes through [`FilesRoot::resolve_existing`] or
/// [`FilesRoot::resolve_parent_for_create`] — no other code joins a wire
/// string onto a path.
#[derive(Debug, Clone)]
pub struct FilesRoot {
    canonical: PathBuf,
}

impl FilesRoot {
    /// Canonicalize and validate the operator's root. `Err` = the gate is
    /// closed (missing, not a directory, or unreadable).
    pub async fn resolve(raw: &str) -> FilesResult<Self> {
        let canonical = tokio::fs::canonicalize(raw).await.map_err(|error| {
            let code = match error.kind() {
                std::io::ErrorKind::NotFound => FilesErrorCode::NotFound,
                _ => FilesErrorCode::IoError,
            };
            FilesError::new(code, format!("files root `{raw}`: {error}"))
        })?;

        let metadata = tokio::fs::metadata(&canonical)
            .await
            .map_err(|error| FilesError::io("stat files root", error))?;
        if !metadata.is_dir() {
            return Err(FilesError::new(
                FilesErrorCode::NotADirectory,
                format!("files root `{raw}` is not a directory"),
            ));
        }

        // Readability probe: canonicalize/stat succeed on a mode-000 directory
        // owned by us; only an actual read fails. The gate must close here,
        // not on the first list (ADR-32).
        tokio::fs::read_dir(&canonical)
            .await
            .map_err(|error| FilesError::io("files root is not readable", error))?;

        Ok(Self { canonical })
    }

    /// The canonical root path.
    pub fn path(&self) -> &Path {
        &self.canonical
    }

    /// Syntactic validation + join, no filesystem calls (spec §2.6 order:
    /// `INVALID_PATH` before any `canonicalize`).
    ///
    /// Rules (ADR-33): POSIX-relative (`''` = root), no absolute paths, no
    /// empty components, no `.` components, no NUL, and no backslash (a
    /// separator on Windows; refusing it on every OS keeps one wire grammar).
    /// `..` deliberately **passes** this stage: the canonicalize + prefix
    /// check is the authority for escapes (spec §6.4's row expects
    /// `PATH_OUTSIDE_ROOT` for `..`, not `INVALID_PATH`).
    fn join_wire(&self, wire: &str) -> FilesResult<PathBuf> {
        if wire.contains('\0') {
            return Err(FilesError::invalid_path("path contains a NUL"));
        }
        if wire.contains('\\') {
            return Err(FilesError::invalid_path("backslash is not a POSIX path separator"));
        }
        if wire.starts_with('/') {
            return Err(FilesError::invalid_path("absolute paths are not allowed"));
        }

        let mut joined = self.canonical.clone();
        if !wire.is_empty() {
            for component in wire.split('/') {
                if component.is_empty() {
                    return Err(FilesError::invalid_path("empty path component"));
                }
                if component == "." {
                    return Err(FilesError::invalid_path("`.` components are not allowed"));
                }
                joined.push(component);
            }
        }
        Ok(joined)
    }

    /// The separator-anchored containment check. `Path::starts_with` is
    /// component-wise, so `/srv/files2` does NOT start with `/srv/files` —
    /// the prefix-confusion trap is closed by the type, not by string math.
    fn ensure_contained(&self, canonical: &Path) -> FilesResult<()> {
        if canonical.starts_with(&self.canonical) {
            Ok(())
        } else {
            Err(FilesError::outside_root())
        }
    }

    /// Validate a wire path (POSIX-relative) and return the canonical target.
    /// The target must exist (canonicalize is the containment proof).
    pub async fn resolve_existing(&self, wire: &str) -> FilesResult<PathBuf> {
        let candidate = self.join_wire(wire)?;
        let canonical = tokio::fs::canonicalize(&candidate).await.map_err(|error| {
            let code = match error.kind() {
                std::io::ErrorKind::NotFound => FilesErrorCode::NotFound,
                _ => FilesErrorCode::IoError,
            };
            FilesError::new(code, format!("`{wire}`: {error}"))
        })?;
        self.ensure_contained(&canonical)?;
        Ok(canonical)
    }

    /// Validate an upload target: `dir_wire` is the directory (`''` = root),
    /// `name` a single component. Returns `(canonical_parent, safe_name)`.
    ///
    /// The target itself does not exist yet, so containment is proven on the
    /// parent (which must exist and be a directory) and the name is validated
    /// as one safe component (ADR-33 rule 1).
    pub async fn resolve_parent_for_create(
        &self,
        dir_wire: &str,
        name: &str,
    ) -> FilesResult<(PathBuf, String)> {
        if name.is_empty() {
            return Err(FilesError::invalid_path("upload name is empty"));
        }
        if name.contains('\0') {
            return Err(FilesError::invalid_path("upload name contains a NUL"));
        }
        if name.contains('/') || name.contains('\\') {
            return Err(FilesError::invalid_path("upload name contains a separator"));
        }
        if name == "." || name == ".." {
            return Err(FilesError::invalid_path("upload name is a dot component"));
        }

        let parent = self.resolve_existing(dir_wire).await?;
        let metadata = tokio::fs::metadata(&parent)
            .await
            .map_err(|error| FilesError::io("stat upload parent", error))?;
        if !metadata.is_dir() {
            return Err(FilesError::not_a_directory());
        }

        Ok((parent, name.to_string()))
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked files::`
Expected: PASS — the 16 `files::` tests (decode guard, round-trip, framing, chunk math, RFC 3339, error spellings, the full path-policy table, root validation).

- [ ] **Step 5: Lint and check the musl target**

Run: `cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`
Expected: clean — the `#[allow(dead_code)]` on `mod files;` (Step 1) is what keeps the bin target's dead-code check quiet until Task 7 wires the dispatch and removes the allow.

Then (if the target is installed) confirm the module compiles on musl — `files.rs` is not gated, so this must build:

```bash
cargo check --manifest-path apps/agent/Cargo.toml --locked --target x86_64-unknown-linux-musl
```

Expected: builds.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/files.rs apps/agent/src/main.rs
git commit -m "feat(agent): files wire layer, chunk math and FilesRoot sandbox"
```

---

### Task 5: Agent — `rtc.rs` `FILES_LABEL` and the generalized `send_approved_answer` (D3, part 2)

**Files:**
- Modify: `apps/agent/src/rtc.rs` (add `FILES_LABEL` beside the existing label constants at `:55-62`; generalize `send_desktop_answer` at `:224-237` into `send_approved_answer` + a one-line delegate)

**Interfaces:**
- Consumes: `send_answer(peer, offer, approved, outbound)` (`rtc.rs:745-770`); `SignalOffer`, `SignalMessage`; `mpsc`.
- Produces (relied on by **Tasks 6, 7**):
  - `pub const FILES_LABEL: &str = "files";`
  - `pub async fn send_approved_answer(peer: &Arc<dyn PeerConnection>, offer: &SignalOffer, outbound: &mpsc::Sender<SignalMessage>) -> Result<()>` — **callable on every target, including musl** (files is not musl-gated).
  - `send_desktop_answer` keeps its name, signature, and `#[cfg(not(target_env = "musl"))]`; its body becomes a one-line delegate to `send_approved_answer`.

> **Why the general helper is NOT gated.** Today's `send_desktop_answer` (`rtc.rs:224-237`) is `#[cfg(not(target_env = "musl"))]` because the desktop *module* is. Files is compiled on every target (spec §6.1), so the shared body must be ungated; only the desktop-named wrapper keeps the cfg. This is the smallest change that gives files an `approved: true` answer without touching `answer_offer`'s terminal-only check (`rtc.rs:722`: `let approved = offer.capabilities.iter().any(|c| c == TERMINAL_LABEL);`) — **do not touch `answer_offer`**.

> **No behavior change for desktop or terminal.** `send_approved_answer` is the exact body `send_desktop_answer` already has (`send_answer(peer, offer, true, outbound)`); the delegate keeps every call site (`main.rs:1175`) compiling unchanged. `SessionHandler` and `on_data_channel` (`rtc.rs:625-651`) need no change — the accepted label is injected at construction (`main.rs:728-741`) and the single-channel rule is label-agnostic.

- [ ] **Step 1: Add the label constant**

In `apps/agent/src/rtc.rs`, after `DESKTOP_LABEL` (`:61-62`), add:

```rust
/// The file transfer channel's label (Week 10, ADR-31). A files session is a
/// data-channel session like the terminal, served over exactly this label.
// Consumed by the files classification in Task 7 (classify_offer +
// accepted_label). The allow is removed there.
#[allow(dead_code)]
pub const FILES_LABEL: &str = "files";
```

- [ ] **Step 2: Generalize the approved-answer helper**

The current block (`rtc.rs:224-237`) is:

```rust
/// Answer a desktop offer with `approved: true` and the SDP just built.
///
/// The track is attached by the caller *before* this runs (ADR-15); this is the
/// same `set_remote_description → create_answer → set_local_description → send`
/// core as [`answer_offer`], with the flag fixed to `true` because the caller
/// has already decided the offer is a desktop offer it can serve.
#[cfg(not(target_env = "musl"))]
pub async fn send_desktop_answer(
    peer: &Arc<dyn PeerConnection>,
    offer: &SignalOffer,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    send_answer(peer, offer, true, outbound).await
}
```

Replace it with the ungated shared helper plus the desktop-named delegate:

```rust
/// Answer an offer with `approved: true` and the SDP just built.
///
/// The caller has already decided this offer is one it can serve (desktop
/// track attached, or a files root resolved), so the flag is fixed to `true`;
/// this is the same `set_remote_description → create_answer →
/// set_local_description → send` core as [`answer_offer`].
///
/// **Not cfg-gated**: `files.rs` is compiled on every target (spec §6.1), so
/// the files dispatch arm needs this on musl too. The desktop-named wrapper
/// below keeps its cfg.
pub async fn send_approved_answer(
    peer: &Arc<dyn PeerConnection>,
    offer: &SignalOffer,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    send_answer(peer, offer, true, outbound).await
}

/// Answer a desktop offer with `approved: true` and the SDP just built.
///
/// The track is attached by the caller *before* this runs (ADR-15). Kept as
/// the desktop-specific name; delegates to [`send_approved_answer`] so the
/// desktop and files approved paths cannot drift.
#[cfg(not(target_env = "musl"))]
pub async fn send_desktop_answer(
    peer: &Arc<dyn PeerConnection>,
    offer: &SignalOffer,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    send_approved_answer(peer, offer, outbound).await
}
```

- [ ] **Step 3: Build and test on the host target**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked && cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`
Expected: PASS — no test changes (this task adds no behavior; the existing suite proves the delegate). Clippy clean: `send_approved_answer` is used by `run_desktop_session` (via the delegate), so it is not dead; `FILES_LABEL` carries the temporary `#[allow(dead_code)]` from Step 1 — its first users are Task 7's `classify_offer` and `accepted_label`, which remove the allow.

- [ ] **Step 4: Check the musl target**

Run: `cargo check --manifest-path apps/agent/Cargo.toml --locked --target x86_64-unknown-linux-musl`
Expected: builds — `send_approved_answer` is ungated and compiles with the desktop module absent; `send_desktop_answer` is cfg'd out exactly as before.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/rtc.rs
git commit -m "refactor(agent): share the approved-answer helper, add FILES_LABEL"
```

> **Residual note for the PR body:** this task intentionally does **not** generalize `answer_offer`'s terminal-only approval (`rtc.rs:722`) — files never reaches it (Task 7's gate and dispatch answer first), and changing it would alter terminal SDP behavior that the Week 7 E2E pins.

---

### Task 6: Agent — `FilesSession` state machine, both directions (D3, part 3)

**Files:**
- Modify: `apps/agent/src/files.rs` (append `ensure_within_cap`, `DownloadState`/`UploadState`, `FilesSession` + private helpers + `FilesError::into_frame`, and the session tests inside the existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: Task 4's module in full — `FilesRoot::{resolve_existing, resolve_parent_for_create}`, `FilesError::{new, with_ids, io, not_a_directory}`, `FilesErrorMessage::from_error`, `decode` outputs (`FilesInbound`), `Outbound`, `FilesErrorCode`, `total_chunks`, `expected_chunk_len(total_chunks, size, chunk_index)`, `part_name`, `FILES_IDLE_TIMEOUT`, `FILE_WINDOW_CHUNKS`, `MAX_LIST_ENTRIES`, `FILE_MAX_BYTES`; `base64::engine::general_purpose::STANDARD`; `tokio::fs`; `tracing`.
- Produces (relied on by **Task 7**; do not rename):
  - `pub fn ensure_within_cap(size: u64) -> FilesResult<()>` (pure; used by this task's begin paths and its tests)
  - `pub struct FilesSession { root: FilesRoot, download: Option<DownloadState>, upload: Option<UploadState> }`
  - `FilesSession::new(root: FilesRoot) -> Self`
  - `pub async fn handle(&mut self, frame: FilesInbound) -> Vec<Outbound>` — the pure-ish core (spec §6.1): validates, mutates state, returns the frames to send
  - `pub async fn check_idle(&mut self) -> Vec<Outbound>` — the session loop's 1 s tick (Task 7 calls it)
  - `pub async fn teardown(&mut self)` — cancel both directions, remove any `.part`, log at info (channel close / session end)
  - `pub fn FilesError::into_frame(self) -> Outbound` — the one way this task turns a failure into `Outbound::Error` (Task 7 may use it for decode failures)

> **Upload acks are part of the contract.** Task 4's `Outbound` has **no** `UploadReady` variant, and that is correct: per spec §2.2/§6.1 the agent answers `files-upload-begin` with `files-upload-ack { nextChunkIndex: 0 }` and ack every accepted chunk (`nextChunkIndex` = contiguous count). The browser's upload pump waits on these acks (§5.2.4), so omitting them deadlocks every upload. The ack stream is `0, 1, 2, …`.

> **One transfer per direction (ADR-34), checked LAST.** A second `files-download`/`files-upload-begin` fails `TRANSFER_BUSY` with the offending id — but only after the path/type/cap checks, following spec §2.6's canonical order: decode → `INVALID_PATH` → `PATH_OUTSIDE_ROOT` → existence/type → caps → busy. One download **and** one upload may run concurrently.

> **No-replace finalize ruling.** ADR-33 wants "rename without replace", but POSIX `rename(2)` silently replaces — so the finalize is `hard_link(part, dest)` (fails `AlreadyExists` when a racer created the target — the exact semantics ADR-33 asks for, on Unix and Windows alike) followed by `remove_file(part)`. `flush` + `sync_all` happen before the link. If the destination wins the race → `FILE_EXISTS` + `.part` cleanup. Recorded as a spec-ambiguity ruling for review.

> **Fail-soft (spec §2.6).** No error returned here is fatal: the caller sends the frames and keeps the session. Every failure cleans up its own state (`.part` removed) so the next request starts clean. `files-cancel` for an unknown id is idempotent (log only). `files-cancel { requestId }` is a no-op: the thin-slice list is served synchronously inside one `handle()` call, so there is never a pending list (spec §5.2.2 records the client exposes no list-cancel handle); the frame logs at debug and returns no frames.

> **Log lines the E2E observes (spec §8.3).** Cancel and teardown log exactly `files transfer cancelled` at **info** with the id: `tracing::info!(transfer_id = %id, "files transfer cancelled")`. Do not change this message. Timeouts log at info with `code = "TRANSFER_TIMEOUT"`.

> **The list is sorted before it is truncated.** Spec §2.5's "first 4096" means the first 4096 in the deterministic order (dirs first, then name byte-wise) — `read_dir` order is arbitrary, so collect all entries, sort, then truncate. A per-entry metadata failure fails the whole list (spec §6.1: a half-listed directory is worse than an error).

- [ ] **Step 1: Write the failing session tests**

Append these to `apps/agent/src/files.rs` inside the existing `#[cfg(test)] mod tests` block (after the path-policy tests; keep every Task 4 test unchanged):

```rust
    // ---- FilesSession state machine (spec §6.4) ----

    /// A session rooted at a fresh temp dir (the dir itself is created by
    /// `temp_dir_for_test`; callers remove it at the end).
    async fn session_for(dir: &std::path::Path) -> FilesSession {
        let root = FilesRoot::resolve(dir.to_str().unwrap()).await.unwrap();
        FilesSession::new(root)
    }

    fn list_req(id: &str, path: &str) -> FilesInbound {
        FilesInbound::List(FilesListRequest { request_id: id.to_string(), path: path.to_string() })
    }

    fn download_req(id: &str, path: &str) -> FilesInbound {
        FilesInbound::Download(FilesDownloadRequest { transfer_id: id.to_string(), path: path.to_string() })
    }

    fn upload_begin(id: &str, dir: &str, name: &str, size: u64) -> FilesInbound {
        FilesInbound::UploadBegin(FilesUploadBeginRequest {
            transfer_id: id.to_string(),
            path: dir.to_string(),
            name: name.to_string(),
            size,
        })
    }

    fn chunk(id: &str, index: u64, total: u64, bytes: &[u8]) -> FilesInbound {
        use base64::Engine as _;
        FilesInbound::UploadChunk(FileChunkMessage {
            transfer_id: id.to_string(),
            chunk_index: index,
            total_chunks: total,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }

    fn upload_end(id: &str) -> FilesInbound {
        FilesInbound::UploadEnd(FilesUploadEndRequest { transfer_id: id.to_string() })
    }

    fn ack(id: &str, next: u64) -> FilesInbound {
        FilesInbound::DownloadAck(FilesAckMessage { transfer_id: id.to_string(), next_chunk_index: next })
    }

    fn cancel(id: &str) -> FilesInbound {
        FilesInbound::Cancel(FilesCancelMessage { request_id: None, transfer_id: Some(id.to_string()) })
    }

    /// The decoded bytes of one `files-download-chunk` frame.
    fn chunk_bytes(frame: &Outbound) -> Vec<u8> {
        use base64::Engine as _;
        let Outbound::DownloadChunk(chunk) = frame else {
            panic!("not a download chunk: {frame:?}");
        };
        base64::engine::general_purpose::STANDARD.decode(&chunk.data).unwrap()
    }

    /// The wire code of the single error frame in `frames` (panics otherwise).
    /// The spellings themselves are pinned exhaustively by Task 4's
    /// `error_code_spellings_are_pinned`; here a string compare is direct.
    fn error_code(frames: &[Outbound]) -> &str {
        let [Outbound::Error(error)] = frames else {
            panic!("expected exactly one error frame, got {frames:?}");
        };
        &error.code
    }

    #[tokio::test]
    async fn list_returns_entries_sorted_dirs_first() {
        let dir = temp_dir_for_test();
        std::fs::create_dir(dir.join("zz-dir")).unwrap();
        std::fs::write(dir.join("b.txt"), b"bb").unwrap();
        std::fs::write(dir.join("a.txt"), b"a").unwrap();

        let mut session = session_for(&dir).await;
        let frames = session.handle(list_req("r-1", "")).await;
        let [Outbound::ListResult(result)] = frames.as_slice() else {
            panic!("expected one list result, got {frames:?}");
        };
        assert_eq!(result.request_id, "r-1");
        assert!(!result.truncated);
        let names: Vec<&str> = result.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["zz-dir", "a.txt", "b.txt"], "dirs first, then name bytewise");
        assert!(result.entries[0].is_directory);
        assert_eq!(result.entries[0].path, "zz-dir");
        assert_eq!(result.entries[1].size, 1);
        assert!(result.entries[1].modified_at.ends_with('Z'), "RFC 3339 UTC");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn list_on_a_file_is_not_a_directory() {
        let dir = temp_dir_for_test();
        std::fs::write(dir.join("f.txt"), b"x").unwrap();
        let mut session = session_for(&dir).await;
        let frames = session.handle(list_req("r-1", "f.txt")).await;
        assert_eq!(error_code(&frames), "NOT_A_DIRECTORY");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn list_cap_truncates_at_4096_with_the_flag() {
        // 4097 entries ⇒ the first 4096 in sorted order, truncated: true.
        let dir = temp_dir_for_test();
        for i in 0..4097 {
            std::fs::write(dir.join(format!("f{i:04}")), b"").unwrap();
        }
        let mut session = session_for(&dir).await;
        let frames = session.handle(list_req("r-1", "")).await;
        let [Outbound::ListResult(result)] = frames.as_slice() else {
            panic!("expected one list result, got {frames:?}");
        };
        assert_eq!(result.entries.len(), MAX_LIST_ENTRIES);
        assert!(result.truncated);
        assert_eq!(result.entries[0].name, "f0000");
        assert_eq!(result.entries[MAX_LIST_ENTRIES - 1].name, "f4095");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn download_acks_gate_the_window() {
        // 20 chunks; after begin only 16 may be in flight; acks open the rest.
        let dir = temp_dir_for_test();
        let size = 20 * FILE_CHUNK_BYTES as usize;
        std::fs::write(dir.join("big.bin"), vec![7u8; size]).unwrap();
        let mut session = session_for(&dir).await;

        let frames = session.handle(download_req("t-1", "big.bin")).await;
        assert!(matches!(frames.first(), Some(Outbound::DownloadBegin(b)) if b.total_chunks == 20 && b.size == size as u64));
        assert_eq!(frames.len(), 17, "begin + 16 chunks");

        // An ack beyond what was sent is BAD_FRAME and kills the transfer
        // (spec §2.4: `nextChunkIndex > sent` is a protocol violation).
        let frames = session.handle(ack("t-1", 17)).await;
        assert_eq!(error_code(&frames), "BAD_FRAME");

        // Start over; a cumulative ack opens the window to the end.
        let frames = session.handle(download_req("t-2", "big.bin")).await;
        assert_eq!(frames.len(), 17);
        let frames = session.handle(ack("t-2", 4)).await;
        assert_eq!(frames.len(), 4, "sent - acked < 16 admits exactly 4 more");
        let frames = session.handle(ack("t-2", 20)).await;
        assert!(matches!(frames.as_slice(), [Outbound::DownloadEnd(e)] if e.transfer_id == "t-2"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn download_assembles_byte_equal_content() {
        let dir = temp_dir_for_test();
        let content: Vec<u8> = (0..(FILE_CHUNK_BYTES as usize + 3)).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.join("a.bin"), &content).unwrap();
        let mut session = session_for(&dir).await;

        let frames = session.handle(download_req("t-1", "a.bin")).await;
        let mut assembled = Vec::new();
        for frame in &frames {
            if matches!(frame, Outbound::DownloadChunk(_)) {
                assembled.extend(chunk_bytes(frame));
            }
        }
        assert_eq!(assembled, content);
        let frames = session.handle(ack("t-1", 2)).await;
        assert!(matches!(frames.as_slice(), [Outbound::DownloadEnd(_)]));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn empty_download_is_begin_then_end() {
        let dir = temp_dir_for_test();
        std::fs::write(dir.join("empty"), b"").unwrap();
        let mut session = session_for(&dir).await;
        let frames = session.handle(download_req("t-1", "empty")).await;
        assert!(matches!(frames.as_slice(), [Outbound::DownloadBegin(b), Outbound::DownloadEnd(_)] if b.total_chunks == 0));

        // Nothing was stored (the transfer completed in one call): a
        // follow-up download starts immediately instead of TRANSFER_BUSY.
        std::fs::write(dir.join("other"), b"x").unwrap();
        let frames = session.handle(download_req("t-2", "other")).await;
        assert!(matches!(frames.first(), Some(Outbound::DownloadBegin(_))));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn download_of_a_directory_is_not_a_file() {
        let dir = temp_dir_for_test();
        std::fs::create_dir(dir.join("sub")).unwrap();
        let mut session = session_for(&dir).await;
        let frames = session.handle(download_req("t-1", "sub")).await;
        assert_eq!(error_code(&frames), "NOT_A_FILE");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn oversize_size_is_rejected_by_the_pure_guard() {
        assert!(ensure_within_cap(FILE_MAX_BYTES).is_ok());
        assert_eq!(ensure_within_cap(FILE_MAX_BYTES + 1).unwrap_err().code, FilesErrorCode::FileTooLarge);

        // The upload path calls it at begin, before any chunk or file.
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        let frames = session.handle(upload_begin("t-1", "", "big", FILE_MAX_BYTES + 1)).await;
        assert_eq!(error_code(&frames), "FILE_TOO_LARGE");
        assert!(!dir.join(part_name("big")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }
```

```rust
    #[tokio::test]
    async fn upload_happy_path_writes_the_file_and_cleans_the_part() {
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        let payload = b"hello files";

        // Begin is answered with the first cumulative ack (spec §6.1).
        let frames = session.handle(upload_begin("t-1", "", "note.txt", payload.len() as u64)).await;
        assert!(matches!(frames.as_slice(), [Outbound::UploadAck(a)] if a.transfer_id == "t-1" && a.next_chunk_index == 0));
        assert!(dir.join(part_name("note.txt")).exists(), ".part is created at begin");

        let frames = session.handle(chunk("t-1", 0, 1, payload)).await;
        assert!(matches!(frames.as_slice(), [Outbound::UploadAck(a)] if a.next_chunk_index == 1));
        let frames = session.handle(upload_end("t-1")).await;
        assert!(matches!(frames.as_slice(), [Outbound::UploadComplete(c)]
            if c.transfer_id == "t-1" && c.name == "note.txt" && c.path == "note.txt" && c.size == payload.len() as u64));
        assert_eq!(std::fs::read(dir.join("note.txt")).unwrap(), payload);
        assert!(!dir.join(part_name("note.txt")).exists(), ".part renamed away");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn empty_upload_finalizes_an_empty_file() {
        // size 0 ⇒ totalChunks 0: begin then end, no chunks (spec §2.5).
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        session.handle(upload_begin("t-1", "", "zero.bin", 0)).await;
        let frames = session.handle(upload_end("t-1")).await;
        assert!(matches!(frames.as_slice(), [Outbound::UploadComplete(c)] if c.size == 0));
        assert_eq!(std::fs::read(dir.join("zero.bin")).unwrap(), b"");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn upload_into_a_missing_directory_is_not_found() {
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        let frames = session.handle(upload_begin("t-1", "nope", "f.bin", 1)).await;
        assert_eq!(error_code(&frames), "NOT_FOUND", "the missing dir fails the resolve");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn upload_of_an_existing_name_is_already_exists() {
        let dir = temp_dir_for_test();
        std::fs::write(dir.join("taken.txt"), b"x").unwrap();
        let mut session = session_for(&dir).await;
        let frames = session.handle(upload_begin("t-1", "", "taken.txt", 1)).await;
        assert_eq!(error_code(&frames), "FILE_EXISTS");
        assert!(!dir.join(part_name("taken.txt")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn stale_part_is_removed_and_retried_once() {
        // A `.part` left by a crashed run is not an error (spec §6.1).
        let dir = temp_dir_for_test();
        std::fs::write(dir.join(part_name("note.txt")), b"stale").unwrap();
        let mut session = session_for(&dir).await;
        let frames = session.handle(upload_begin("t-1", "", "note.txt", 3)).await;
        assert!(matches!(frames.as_slice(), [Outbound::UploadAck(_)]), "begin succeeds over a stale .part");
        assert_eq!(std::fs::read(dir.join(part_name("note.txt"))).unwrap(), b"", "stale bytes are gone");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn upload_end_before_the_last_chunk_is_bad_frame() {
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        session.handle(upload_begin("t-1", "", "two.bin", 2 * FILE_CHUNK_BYTES as u64)).await;
        session.handle(chunk("t-1", 0, 2, &vec![1u8; FILE_CHUNK_BYTES as usize])).await;

        let frames = session.handle(upload_end("t-1")).await;
        assert_eq!(error_code(&frames), "BAD_FRAME");
        assert!(!dir.join(part_name("two.bin")).exists(), "state cleared and .part removed");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn chunk_with_the_wrong_index_is_bad_frame() {
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        session.handle(upload_begin("t-1", "", "x.bin", 1)).await;
        let frames = session.handle(chunk("t-1", 1, 1, b"x")).await;
        assert_eq!(error_code(&frames), "BAD_FRAME");
        assert!(!dir.join(part_name("x.bin")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn upload_ack_stream_is_cumulative() {
        // Spec §6.1: begin acks 0, every accepted chunk acks its contiguous
        // count. The browser's upload pump waits on exactly this stream.
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        let full = vec![9u8; FILE_CHUNK_BYTES as usize];
        let size = 2 * FILE_CHUNK_BYTES as u64 + 5;

        let frames = session.handle(upload_begin("t-1", "", "three.bin", size)).await;
        assert!(matches!(frames.as_slice(), [Outbound::UploadAck(a)] if a.next_chunk_index == 0));
        let frames = session.handle(chunk("t-1", 0, 3, &full)).await;
        assert!(matches!(frames.as_slice(), [Outbound::UploadAck(a)] if a.next_chunk_index == 1));
        let frames = session.handle(chunk("t-1", 1, 3, &full)).await;
        assert!(matches!(frames.as_slice(), [Outbound::UploadAck(a)] if a.next_chunk_index == 2));
        let frames = session.handle(chunk("t-1", 2, 3, b"abcde")).await;
        assert!(matches!(frames.as_slice(), [Outbound::UploadAck(a)] if a.next_chunk_index == 3));
        let frames = session.handle(upload_end("t-1")).await;
        assert!(matches!(frames.as_slice(), [Outbound::UploadComplete(c)] if c.size == size));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn chunk_for_an_unknown_id_is_transfer_unknown() {
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        let frames = session.handle(chunk("ghost", 0, 1, b"x")).await;
        assert_eq!(error_code(&frames), "TRANSFER_UNKNOWN");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn chunk_length_mismatch_is_bad_frame() {
        // The last chunk's length is implied by size, so a short one cannot be
        // padded silently; spec §2.4 pins the failure.
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        let size = FILE_CHUNK_BYTES as u64 + 3;
        session.handle(upload_begin("t-1", "", "s.bin", size)).await;
        session.handle(chunk("t-1", 0, 2, &vec![1u8; FILE_CHUNK_BYTES as usize])).await;
        let frames = session.handle(chunk("t-1", 1, 2, b"ab")).await;
        assert_eq!(error_code(&frames), "BAD_FRAME");
        assert!(!dir.join(part_name("s.bin")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn upload_totals_changed_mid_flight_is_bad_frame() {
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        session.handle(upload_begin("t-1", "", "m.bin", FILE_CHUNK_BYTES as u64)).await;
        let frames = session.handle(chunk("t-1", 0, 9, b"x")).await;
        assert_eq!(error_code(&frames), "BAD_FRAME");
        assert!(!dir.join(part_name("m.bin")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn finalize_race_losing_path_is_file_exists() {
        // ADR-33 defense in depth: a target created between begin and end
        // loses the no-replace finalize → FILE_EXISTS + `.part` cleanup.
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        session.handle(upload_begin("t-1", "", "race.bin", 1)).await;
        session.handle(chunk("t-1", 0, 1, b"z")).await;
        std::fs::write(dir.join("race.bin"), b"winner").unwrap();

        let frames = session.handle(upload_end("t-1")).await;
        assert_eq!(error_code(&frames), "FILE_EXISTS");
        assert_eq!(std::fs::read(dir.join("race.bin")).unwrap(), b"winner", "the existing file is untouched");
        assert!(!dir.join(part_name("race.bin")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_second_transfer_in_the_same_direction_is_busy() {
        let dir = temp_dir_for_test();
        std::fs::write(dir.join("a.bin"), vec![0u8; FILE_CHUNK_BYTES as usize]).unwrap();
        let mut session = session_for(&dir).await;

        session.handle(download_req("t-1", "a.bin")).await;
        let frames = session.handle(download_req("t-2", "a.bin")).await;
        assert_eq!(error_code(&frames), "TRANSFER_BUSY");
        let Outbound::Error(error) = &frames[0] else { unreachable!() };
        assert_eq!(error.transfer_id.as_deref(), Some("t-2"), "the busy error names the offending id");

        session.handle(upload_begin("u-1", "", "up.bin", 1)).await;
        let frames = session.handle(upload_begin("u-2", "", "up2.bin", 1)).await;
        assert_eq!(error_code(&frames), "TRANSFER_BUSY");

        // But one of each is fine: the download above did not block the upload.
        assert!(dir.join(part_name("up.bin")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn busy_is_checked_after_the_path_checks() {
        // Spec §2.6's order: an escaping path fails PATH_OUTSIDE_ROOT even
        // while a download is running, not TRANSFER_BUSY. (`../..` resolves
        // to the temp dir's parent — an existing dir — so canonicalize
        // succeeds and the prefix check is what rejects it.)
        let dir = temp_dir_for_test();
        std::fs::write(dir.join("a.bin"), vec![0u8; 2 * FILE_CHUNK_BYTES as usize]).unwrap();
        let mut session = session_for(&dir).await;
        session.handle(download_req("t-1", "a.bin")).await;

        let frames = session.handle(download_req("t-2", "../..")).await;
        assert_eq!(error_code(&frames), "PATH_OUTSIDE_ROOT");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_completed_download_frees_the_slot() {
        // After the end frame the direction is idle: the same id may be
        // reused, a late ack is TRANSFER_UNKNOWN, and the idle tick has
        // nothing to time out (the completion lifecycle).
        let dir = temp_dir_for_test();
        std::fs::write(dir.join("a.bin"), vec![3u8; FILE_CHUNK_BYTES as usize]).unwrap();
        std::fs::write(dir.join("b.bin"), vec![4u8; FILE_CHUNK_BYTES as usize]).unwrap();
        let mut session = session_for(&dir).await;

        session.handle(download_req("t-1", "a.bin")).await;
        let frames = session.handle(ack("t-1", 1)).await;
        assert!(matches!(frames.as_slice(), [Outbound::DownloadEnd(_)]));
        assert!(session.download.is_none(), "the slot is free after the end frame");

        // A second download (new id, other file) must begin, not be busy.
        let frames = session.handle(download_req("t-2", "b.bin")).await;
        assert!(matches!(frames.first(), Some(Outbound::DownloadBegin(_))), "not TRANSFER_BUSY");
        // Reusing the finished id is not TRANSFER_BUSY either, and the idle
        // tick has nothing to time out for the completed transfer.
        assert!(session.check_idle().await.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn cancel_stops_the_download_and_removes_the_state() {
        let dir = temp_dir_for_test();
        std::fs::write(dir.join("a.bin"), vec![0u8; 2 * FILE_CHUNK_BYTES as usize]).unwrap();
        let mut session = session_for(&dir).await;
        session.handle(download_req("t-1", "a.bin")).await;

        let frames = session.handle(cancel("t-1")).await;
        assert!(frames.is_empty(), "cancel itself is silent");
        // A later ack for the cancelled id is TRANSFER_UNKNOWN: state is gone.
        let frames = session.handle(ack("t-1", 1)).await;
        assert_eq!(error_code(&frames), "TRANSFER_UNKNOWN");
        // And the id can be reused at once.
        let frames = session.handle(download_req("t-1", "a.bin")).await;
        assert!(matches!(frames.first(), Some(Outbound::DownloadBegin(_))));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn cancel_of_an_upload_removes_the_part_file() {
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        session.handle(upload_begin("t-1", "", "up.bin", 10)).await;
        session.handle(chunk("t-1", 0, 1, b"0123456789")).await;

        let frames = session.handle(cancel("t-1")).await;
        assert!(frames.is_empty());
        assert!(!dir.join(part_name("up.bin")).exists(), ".part removed on cancel");
        assert!(!dir.join("up.bin").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn cancel_for_an_unknown_id_is_idempotent() {
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        let frames = session.handle(cancel("nobody")).await;
        assert!(frames.is_empty(), "no error frame for an unknown cancel");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn idle_timeout_kills_a_stalled_transfer() {
        let dir = temp_dir_for_test();
        std::fs::write(dir.join("a.bin"), vec![0u8; FILE_CHUNK_BYTES as usize]).unwrap();
        let mut session = session_for(&dir).await;
        session.handle(download_req("t-1", "a.bin")).await;

        assert!(session.check_idle().await.is_empty(), "fresh transfer is not idle");

        // Rewind the deadline past the timeout; the tick then fails it.
        session.download.as_mut().unwrap().deadline = tokio::time::Instant::now() - std::time::Duration::from_secs(1);
        let frames = session.check_idle().await;
        let Outbound::Error(error) = &frames[0] else { panic!("expected the timeout frame, got {frames:?}") };
        assert_eq!(error.code, "TRANSFER_TIMEOUT");
        assert_eq!(error.transfer_id.as_deref(), Some("t-1"));

        let frames = session.handle(ack("t-1", 1)).await;
        assert_eq!(error_code(&frames), "TRANSFER_UNKNOWN", "state cleaned after timeout");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn idle_timeout_removes_a_stalled_uploads_part() {
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        session.handle(upload_begin("u-1", "", "up.bin", 10)).await;
        session.upload.as_mut().unwrap().deadline = tokio::time::Instant::now() - std::time::Duration::from_secs(1);

        let frames = session.check_idle().await;
        assert!(matches!(frames.as_slice(), [Outbound::Error(e)] if e.code == "TRANSFER_TIMEOUT"));
        assert!(!dir.join(part_name("up.bin")).exists(), ".part removed on timeout");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn teardown_clears_both_directions() {
        let dir = temp_dir_for_test();
        std::fs::write(dir.join("a.bin"), vec![0u8; FILE_CHUNK_BYTES as usize]).unwrap();
        let mut session = session_for(&dir).await;
        session.handle(download_req("t-1", "a.bin")).await;
        session.handle(upload_begin("u-1", "", "up.bin", 1)).await;

        session.teardown().await;
        assert!(session.download.is_none() && session.upload.is_none());
        assert!(!dir.join(part_name("up.bin")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }
```

- [ ] **Step 2: Run the tests — they must fail to compile**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked`
Expected: FAIL — `FilesSession`, `ensure_within_cap` and the state types do not exist yet (Task 4 defined the wire layer only). This is the TDD red state.

- [ ] **Step 3: Implement the state types, the session core, and the list handler**

Append to `apps/agent/src/files.rs`, after the sandbox block and before `#[cfg(test)] mod tests`:

```rust
// ---- the session state machine (spec §6.1) ----

/// Reject a declared/observed size above the 1 GiB cap (spec §2.5,
/// `FILE_TOO_LARGE`). Pure so both directions share one guard.
pub fn ensure_within_cap(size: u64) -> FilesResult<()> {
    if size > FILE_MAX_BYTES {
        return Err(FilesError::new(
            FilesErrorCode::FileTooLarge,
            format!("size {size} exceeds the {FILE_MAX_BYTES} byte cap"),
        ));
    }
    Ok(())
}

impl FilesError {
    /// The `files-error` frame this failure becomes. The one way Task 6 turns
    /// a `FilesError` into an `Outbound` (the ids are set with `with_ids` by
    /// the caller that knows which request/transfer failed).
    pub fn into_frame(self) -> Outbound {
        Outbound::Error(FilesErrorMessage::from_error(&self))
    }
}

/// An in-flight download (agent → browser).
struct DownloadState {
    transfer_id: String,
    file: tokio::fs::File,
    /// The file's stat size — the one source of truth for chunk lengths
    /// (`expected_chunk_len(total_chunks, size, index)`), never the frame's
    /// claim (spec §2.4).
    size: u64,
    total_chunks: u64,
    /// Next chunk index to read; also the count sent so far.
    sent: u64,
    /// Contiguous count the browser has acked.
    acked: u64,
    deadline: tokio::time::Instant,
}

impl DownloadState {
    /// The window rule (spec §2.4): send while `sent - acked < 16`.
    fn window_open(&self) -> bool {
        self.sent - self.acked < FILE_WINDOW_CHUNKS
    }

    fn touch(&mut self) {
        self.deadline = tokio::time::Instant::now() + FILES_IDLE_TIMEOUT;
    }
}

/// An in-flight upload (browser → agent).
struct UploadState {
    transfer_id: String,
    /// Full wire path of the final file (`''`-joined), for `UploadComplete`.
    dest_rel: String,
    /// The absolute final path; the `.part` sibling is derived from it.
    dest: PathBuf,
    part: PathBuf,
    file: tokio::fs::File,
    total_chunks: u64,
    expected_size: u64,
    /// Contiguous chunks accepted so far.
    next_chunk: u64,
    /// Total bytes written; the end-check compares it with `expected_size`.
    written: u64,
    deadline: tokio::time::Instant,
}

impl UploadState {
    fn touch(&mut self) {
        self.deadline = tokio::time::Instant::now() + FILES_IDLE_TIMEOUT;
    }

    /// Remove the `.part` file; safe to call when it is already gone.
    async fn discard(&self) {
        tokio::fs::remove_file(&self.part).await.ok();
    }
}

/// The `files` channel's session state: the resolved root plus at most one
/// in-flight transfer per direction (ADR-34).
pub struct FilesSession {
    root: FilesRoot,
    download: Option<DownloadState>,
    upload: Option<UploadState>,
}

impl FilesSession {
    pub fn new(root: FilesRoot) -> Self {
        Self { root, download: None, upload: None }
    }

    /// Handle one inbound frame; the returned frames are the ones to send.
    /// Fail-soft: an error is a frame, not a fatal outcome (spec §2.6).
    pub async fn handle(&mut self, frame: FilesInbound) -> Vec<Outbound> {
        match frame {
            FilesInbound::List(request) => self.handle_list(request).await,
            FilesInbound::Download(request) => self.handle_download(request).await,
            FilesInbound::UploadBegin(request) => self.handle_upload_begin(request).await,
            FilesInbound::UploadChunk(chunk) => self.handle_upload_chunk(chunk).await,
            FilesInbound::UploadEnd(end) => self.handle_upload_end(end).await,
            FilesInbound::DownloadAck(ack) => self.handle_download_ack(ack).await,
            FilesInbound::Cancel(cancel) => self.handle_cancel(cancel).await,
        }
    }

    /// Cancel anything idle past its deadline (Task 7 calls this every 1 s;
    /// `FILES_IDLE_TIMEOUT` is 50 ms under `cfg(test)` so tests never sleep
    /// the production 30 s, spec §6.4).
    pub async fn check_idle(&mut self) -> Vec<Outbound> {
        let now = tokio::time::Instant::now();
        let mut frames = Vec::new();
        if self.download.as_ref().is_some_and(|s| s.deadline <= now) {
            let state = self.download.take().expect("checked just above");
            frames.push(Self::timeout_frame("download", &state.transfer_id));
        }
        if self.upload.as_ref().is_some_and(|s| s.deadline <= now) {
            let state = self.upload.take().expect("checked just above");
            state.discard().await;
            frames.push(Self::timeout_frame("upload", &state.transfer_id));
        }
        frames
    }

    /// Drop both directions and remove any `.part` (channel closed / session
    /// end). Logs at info so the E2E can observe it (spec §8.3).
    pub async fn teardown(&mut self) {
        if let Some(state) = self.download.take() {
            tracing::info!(transfer_id = %state.transfer_id, "files transfer cancelled");
        }
        if let Some(state) = self.upload.take() {
            tracing::info!(transfer_id = %state.transfer_id, "files transfer cancelled");
            state.discard().await;
        }
    }

    fn timeout_frame(direction: &str, transfer_id: &str) -> Outbound {
        tracing::info!(transfer_id, direction, code = "TRANSFER_TIMEOUT", "files transfer timed out");
        FilesError::new(
            FilesErrorCode::TransferTimeout,
            format!("{direction} transfer idle for more than {FILES_IDLE_TIMEOUT_MS} ms"),
        )
        .with_ids(None, Some(transfer_id.to_string()))
        .into_frame()
    }

    /// The `TRANSFER_UNKNOWN` frame for a chunk/ack that matches nothing.
    fn transfer_unknown(transfer_id: &str) -> Outbound {
        FilesError::new(FilesErrorCode::TransferUnknown, format!("no transfer with id `{transfer_id}`"))
            .with_ids(None, Some(transfer_id.to_string()))
            .into_frame()
    }

    /// Serve `files-list` in one pass (spec §5.2): sorted, dirs first, capped.
    async fn handle_list(&mut self, request: FilesListRequest) -> Vec<Outbound> {
        match self.list_entries(&request.path).await {
            Ok((entries, truncated)) => vec![Outbound::ListResult(FilesListResult {
                request_id: request.request_id,
                path: request.path,
                entries,
                truncated,
            })],
            Err(error) => vec![error.with_ids(Some(request.request_id), None).into_frame()],
        }
    }

    async fn list_entries(&self, rel: &str) -> FilesResult<(Vec<RemoteFile>, bool)> {
        let dir = self.root.resolve_existing(rel).await?;
        let mut read = tokio::fs::read_dir(&dir).await.map_err(|error| {
            // A file where a directory was expected is NOT_A_DIRECTORY; other
            // failures are IO_ERROR (spec §6.1: a per-entry metadata failure
            // fails the whole list — a half-listed directory is worse).
            let code = match error.kind() {
                std::io::ErrorKind::NotADirectory => FilesErrorCode::NotADirectory,
                _ => FilesErrorCode::IoError,
            };
            FilesError::new(code, format!("listing `{rel}`: {error}"))
        })?;
        let mut entries = Vec::new();
        while let Some(entry) = read
            .next_entry()
            .await
            .map_err(|error| FilesError::io(&format!("listing `{rel}`"), error))?
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            let metadata = entry
                .metadata()
                .await
                .map_err(|error| FilesError::io(&format!("stat `{name}`"), error))?;
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| rfc3339_utc(since.as_secs()))
                .unwrap_or_default();
            entries.push(RemoteFile {
                path: join_rel(rel, &name),
                name,
                size: metadata.len(),
                is_directory: metadata.is_dir(),
                modified_at,
            });
        }
        // Deterministic order (spec §2.5): directories first, then name
        // byte-wise — sort BEFORE truncating, `read_dir` order is arbitrary.
        entries.sort_by(|a, b| {
            b.is_directory
                .cmp(&a.is_directory)
                .then_with(|| a.name.as_bytes().cmp(b.name.as_bytes()))
        });
        let truncated = entries.len() > MAX_LIST_ENTRIES;
        entries.truncate(MAX_LIST_ENTRIES);
        Ok((entries, truncated))
    }

    // Leave `impl FilesSession` open: Steps 4 and 5 add the transfer handlers
    // and close it. `join_rel` lands with the free helpers at the end of Step 5.
```

- [ ] **Step 4: Implement the download handlers**

Append inside `impl FilesSession`:

```rust
    async fn handle_download(&mut self, request: FilesDownloadRequest) -> Vec<Outbound> {
        // Order of checks (spec §2.6): the path/type/cap checks run FIRST; a
        // busy slot is reported only for an otherwise-valid request.
        let target = match self.download_target(&request.path).await {
            Ok(target) => target,
            Err(error) => return vec![error.with_ids(None, Some(request.transfer_id)).into_frame()],
        };
        if self.download.is_some() {
            return vec![FilesError::new(FilesErrorCode::TransferBusy, "a download is already running")
                .with_ids(None, Some(request.transfer_id))
                .into_frame()];
        }
        match self.start_download(request, target).await {
            Ok(frames) => frames,
            Err((transfer_id, error)) => vec![error.with_ids(None, Some(transfer_id)).into_frame()],
        }
    }

    /// Resolve + stat a download target: `NOT_A_FILE` for directories, the
    /// cap checked on `metadata.len()` (spec §2.5).
    async fn download_target(&self, path: &str) -> FilesResult<(tokio::fs::File, u64)> {
        let canonical = self.root.resolve_existing(path).await?;
        let metadata = tokio::fs::metadata(&canonical)
            .await
            .map_err(|error| FilesError::io(&format!("stat `{path}`"), error))?;
        if !metadata.is_file() {
            return Err(FilesError::new(FilesErrorCode::NotAFile, format!("`{path}` is not a regular file")));
        }
        ensure_within_cap(metadata.len())?;
        let file = tokio::fs::File::open(&canonical)
            .await
            .map_err(|error| FilesError::io(&format!("open `{path}`"), error))?;
        Ok((file, metadata.len()))
    }

    async fn start_download(
        &mut self,
        request: FilesDownloadRequest,
        (file, size): (tokio::fs::File, u64),
    ) -> Result<Vec<Outbound>, (String, FilesError)> {
        let transfer_id = request.transfer_id;
        let total = total_chunks(size);
        let mut state = DownloadState {
            transfer_id: transfer_id.clone(),
            file,
            size,
            total_chunks: total,
            sent: 0,
            acked: 0,
            deadline: tokio::time::Instant::now() + FILES_IDLE_TIMEOUT,
        };
        let mut frames = vec![Outbound::DownloadBegin(FilesDownloadBegin {
            transfer_id: transfer_id.clone(),
            name: request.path.rsplit('/').next().unwrap_or_default().to_string(),
            path: request.path,
            size,
            total_chunks: total,
        })];
        let pumped = self.pump_download(&mut state).await.map_err(|error| (transfer_id, error))?;
        frames.extend(pumped);
        // A finished transfer (the empty file: begin + end in this one call)
        // does not occupy the slot (ADR-34: one *in-flight* transfer).
        if state.acked < state.total_chunks {
            self.download = Some(state);
        }
        Ok(frames)
    }

    /// Emit window-limited chunks plus the end frame when everything is acked.
    /// Reads happen only as the window opens, so a slow peer never makes the
    /// agent buffer the file (spec §6.1).
    async fn pump_download(&self, state: &mut DownloadState) -> FilesResult<Vec<Outbound>> {
        use tokio::io::AsyncReadExt as _;
        let mut frames = Vec::new();
        while state.sent < state.total_chunks && state.window_open() {
            let len = expected_chunk_len(state.total_chunks, state.size, state.sent) as usize;
            let mut buffer = vec![0u8; len];
            state
                .file
                .read_exact(&mut buffer)
                .await
                .map_err(|error| FilesError::io("reading a download chunk", error))?;
            frames.push(Outbound::DownloadChunk(FileChunkMessage {
                transfer_id: state.transfer_id.clone(),
                chunk_index: state.sent,
                total_chunks: state.total_chunks,
                data: base64::engine::general_purpose::STANDARD.encode(&buffer),
            }));
            state.sent += 1;
        }
        state.touch();
        // End when every chunk is acked; `acked >= total` is also true for
        // the empty file (0 >= 0), which sends begin + end in one call.
        if state.acked >= state.total_chunks {
            frames.push(Outbound::DownloadEnd(FilesDownloadEnd { transfer_id: state.transfer_id.clone() }));
        }
        Ok(frames)
    }

    async fn handle_download_ack(&mut self, ack: FilesAckMessage) -> Vec<Outbound> {
        // Scope the immutable-ish checks so the mutable `take()` below does
        // not fight the borrow of `self.download` (NLL ends the borrow here).
        let beyond_sent = {
            let Some(state) = self.download.as_ref() else {
                return vec![Self::transfer_unknown(&ack.transfer_id)];
            };
            if state.transfer_id != ack.transfer_id {
                return vec![Self::transfer_unknown(&ack.transfer_id)];
            }
            // `nextChunkIndex > sent` is a protocol violation (spec §2.4).
            ack.next_chunk_index > state.sent
        };
        if beyond_sent {
            let state = self.download.take().expect("checked above");
            return vec![FilesError::new(FilesErrorCode::BadFrame, "ack beyond what was sent")
                .with_ids(None, Some(state.transfer_id))
                .into_frame()];
        }
        let mut state = self.download.take().expect("checked above");
        if ack.next_chunk_index > state.acked {
            state.acked = ack.next_chunk_index;
            state.touch();
        }
        // Duplicate/regressive acks are ignored, not errors (spec §2.4).
        match self.pump_download(&mut state).await {
            Ok(frames) => {
                if state.acked < state.total_chunks {
                    self.download = Some(state);
                }
                frames
            }
            Err(error) => {
                // The read failed: the transfer is over, nothing to keep.
                vec![error.with_ids(None, Some(state.transfer_id)).into_frame()]
            }
        }
    }
```

> **The completion lifecycle.** Both store sites keep the state only while `acked < total_chunks` — i.e. only while the transfer is in flight. A completed download drops its state, which (a) frees the direction's slot immediately (the next `files-download` is not `TRANSFER_BUSY`), (b) makes a late ack for the finished id `TRANSFER_UNKNOWN`, and (c) keeps the idle tick from timing out a transfer that already succeeded.

> **Why `size` is stored on `DownloadState`.** `expected_chunk_len(total_chunks, size, index)` needs the real stat size to size the final short chunk; with a padded size the last `read_exact` would run past EOF and fail a valid download. The size is fixed at begin (the file is stat'ed once, spec §2.4: one source of truth) and every chunk read uses it.

- [ ] **Step 5: Implement the upload handlers**

Append inside `impl FilesSession`:

```rust
    async fn handle_upload_begin(&mut self, request: FilesUploadBeginRequest) -> Vec<Outbound> {
        // Order of checks (spec §2.6): name grammar + resolve/type
        // (INVALID_PATH / NOT_FOUND / NOT_A_DIRECTORY), existing target
        // (FILE_EXISTS), size cap (FILE_TOO_LARGE) — busy LAST.
        let result = self.prepare_upload(&request).await;
        let (dest_rel, dest) = match result {
            Ok(prepared) => prepared,
            Err(error) => return vec![error.with_ids(None, Some(request.transfer_id)).into_frame()],
        };
        if self.upload.is_some() {
            return vec![FilesError::new(FilesErrorCode::TransferBusy, "an upload is already running")
                .with_ids(None, Some(request.transfer_id))
                .into_frame()];
        }
        match self.start_upload(request, dest_rel, dest).await {
            Ok(frames) => frames,
            Err((transfer_id, error)) => vec![error.with_ids(None, Some(transfer_id)).into_frame()],
        }
    }

    /// Validate everything an upload-begin must satisfy, without touching
    /// session state: `(wire path of the final file, absolute final path)`.
    /// Follows spec §2.6's order: path/type, existence, then caps.
    async fn prepare_upload(&self, request: &FilesUploadBeginRequest) -> FilesResult<(String, PathBuf)> {
        // Name grammar and parent resolution/type are `resolve_parent_for_create`'s
        // job (ADR-33 rule 1; NOT_FOUND/NOT_A_DIRECTORY/INVALID_PATH).
        let (parent, name) = self.root.resolve_parent_for_create(&request.path, &request.name).await?;
        let dest = parent.join(&name);
        if tokio::fs::try_exists(&dest).await.map_err(|error| FilesError::io("probing the upload target", error))? {
            return Err(FilesError::new(FilesErrorCode::FileExists, format!("`{}` already exists", request.name)));
        }
        ensure_within_cap(request.size)?;
        Ok((join_rel(&request.path, &name), dest))
    }

    async fn start_upload(
        &mut self,
        request: FilesUploadBeginRequest,
        dest_rel: String,
        dest: PathBuf,
    ) -> Result<Vec<Outbound>, (String, FilesError)> {
        let transfer_id = request.transfer_id;
        let part = part_path(&dest);
        // Exclusive create; a stale `.part` (a crashed run) is removed and
        // retried once, then it is a real IO_ERROR (spec §6.1).
        let file = match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&part).await {
            Ok(file) => file,
            Err(first) if first.kind() == std::io::ErrorKind::AlreadyExists => {
                tokio::fs::remove_file(&part)
                    .await
                    .map_err(|error| (transfer_id.clone(), FilesError::io("removing a stale .part", error)))?;
                tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&part)
                    .await
                    .map_err(|error| (transfer_id.clone(), FilesError::io("creating the upload .part", error)))?
            }
            Err(error) => return Err((transfer_id, FilesError::io("creating the upload .part", error))),
        };
        let state = UploadState {
            transfer_id: transfer_id.clone(),
            dest_rel,
            dest,
            part,
            file,
            total_chunks: total_chunks(request.size),
            expected_size: request.size,
            next_chunk: 0,
            written: 0,
            deadline: tokio::time::Instant::now() + FILES_IDLE_TIMEOUT,
        };
        self.upload = Some(state);
        // The begin is answered with the first cumulative ack (spec §6.1).
        Ok(vec![Outbound::UploadAck(FilesAckMessage { transfer_id, next_chunk_index: 0 })])
    }

    async fn handle_upload_chunk(&mut self, chunk: FileChunkMessage) -> Vec<Outbound> {
        let Some(state) = &mut self.upload else {
            return vec![Self::transfer_unknown(&chunk.transfer_id)];
        };
        if state.transfer_id != chunk.transfer_id {
            return vec![Self::transfer_unknown(&chunk.transfer_id)];
        }
        let mut state = self.upload.take().expect("checked above");
        match accept_chunk(state, chunk).await {
            Ok(state) => {
                let ack = Outbound::UploadAck(FilesAckMessage {
                    transfer_id: state.transfer_id.clone(),
                    next_chunk_index: state.next_chunk,
                });
                self.upload = Some(state);
                vec![ack]
            }
            Err((state, error)) => {
                // The whole transfer fails and cleans up (spec §2.6); the
                // session stays alive.
                state.discard().await;
                vec![error.with_ids(None, Some(state.transfer_id)).into_frame()]
            }
        }
    }

    async fn handle_upload_end(&mut self, end: FilesUploadEndRequest) -> Vec<Outbound> {
        let Some(state) = &mut self.upload else {
            return vec![Self::transfer_unknown(&end.transfer_id)];
        };
        if state.transfer_id != end.transfer_id {
            return vec![Self::transfer_unknown(&end.transfer_id)];
        }
        let state = self.upload.take().expect("checked above");
        match finalize_upload(state).await {
            Ok(frame) => vec![frame],
            Err((transfer_id, error)) => vec![error.with_ids(None, Some(transfer_id)).into_frame()],
        }
    }

    async fn handle_cancel(&mut self, cancel: FilesCancelMessage) -> Vec<Outbound> {
        if let Some(id) = &cancel.transfer_id {
            if self.download.as_ref().is_some_and(|s| &s.transfer_id == id) {
                tracing::info!(transfer_id = %id, "files transfer cancelled");
                self.download = None;
                return Vec::new();
            }
            if self.upload.as_ref().is_some_and(|s| &s.transfer_id == id) {
                let state = self.upload.take().expect("checked just above");
                tracing::info!(transfer_id = %id, "files transfer cancelled");
                state.discard().await;
                return Vec::new();
            }
        }
        // Unknown id, or a requestId-only cancel: idempotent, log only
        // (spec §2.6; the thin-slice list is served synchronously so a
        // `requestId` cancel has nothing pending to abort, spec §5.2.2).
        tracing::debug!(?cancel.request_id, ?cancel.transfer_id, "files cancel for nothing in flight");
        Vec::new()
    }
}

/// The `.part` sibling path of a destination (ADR-33: the final name must
/// never appear half-written).
fn part_path(dest: &Path) -> PathBuf {
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    dest.with_file_name(part_name(&name))
}

/// Join a wire-relative path with one entry name (`''` root ⇒ the name).
fn join_rel(dir_wire: &str, name: &str) -> String {
    if dir_wire.is_empty() {
        name.to_string()
    } else {
        format!("{dir_wire}/{name}")
    }
}

/// Validate one chunk against the state; on success append it to `.part`.
/// `Err` hands the state back so the caller can remove the file (fail-soft
/// cleanup, spec §2.6).
async fn accept_chunk(mut state: UploadState, chunk: FileChunkMessage) -> Result<UploadState, (UploadState, FilesError)> {
    use tokio::io::AsyncWriteExt as _;
    let fail = |state: UploadState, message: &str| {
        Err((state, FilesError::new(FilesErrorCode::BadFrame, message)))
    };
    // One source of truth: the totals derived from the declared size, never
    // the frame's claim (spec §2.4).
    if chunk.total_chunks != state.total_chunks {
        return fail(state, "totalChunks disagrees with the declared size");
    }
    if chunk.chunk_index != state.next_chunk {
        return fail(state, "chunk out of order");
    }
    use base64::Engine as _;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(&chunk.data) {
        Ok(bytes) => bytes,
        Err(_) => return fail(state, "chunk data is not valid base64"),
    };
    let expected = expected_chunk_len(state.total_chunks, state.expected_size, state.next_chunk) as usize;
    if bytes.len() != expected {
        return fail(state, "chunk length does not match the declared size");
    }
    if let Err(error) = state.file.write_all(&bytes).await {
        return Err((state, FilesError::io("appending an upload chunk", error)));
    }
    state.next_chunk += 1;
    state.written += bytes.len() as u64;
    state.touch();
    Ok(state)
}

/// Finalize an upload: every chunk arrived ⇒ flush + fsync + no-replace
/// rename (ADR-33). Any failure removes the `.part` and reports.
async fn finalize_upload(mut state: UploadState) -> Result<Outbound, (String, FilesError)> {
    use tokio::io::AsyncWriteExt as _;
    let transfer_id = state.transfer_id.clone();
    if state.next_chunk != state.total_chunks || state.written != state.expected_size {
        state.discard().await;
        return Err((transfer_id, FilesError::new(FilesErrorCode::BadFrame, "upload ended before every chunk arrived")));
    }
    if let Err(error) = state.file.flush().await {
        state.discard().await;
        return Err((transfer_id, FilesError::io("flushing the upload", error)));
    }
    if let Err(error) = state.file.sync_all().await {
        state.discard().await;
        return Err((transfer_id, FilesError::io("syncing the upload", error)));
    }
    drop(state.file);
    // `rename(2)` replaces on POSIX, so the no-replace semantics ADR-33 asks
    // for are `hard_link` (fails when the destination exists — the race-
    // losing path) followed by removing the `.part` link. Note: after
    // `drop(state.file)` the struct is partially moved, so cleanup here
    // touches `state.part` directly rather than calling `state.discard()`.
    if let Err(error) = tokio::fs::hard_link(&state.part, &state.dest).await {
        tokio::fs::remove_file(&state.part).await.ok();
        let mapped = if error.kind() == std::io::ErrorKind::AlreadyExists {
            FilesError::new(FilesErrorCode::FileExists, "the destination was created while the upload ran")
        } else {
            FilesError::io("linking the upload into place", error)
        };
        return Err((transfer_id, mapped));
    }
    if let Err(error) = tokio::fs::remove_file(&state.part).await {
        // The final file is complete; a leftover hard link is the worse
        // outcome only cosmetically — report it, do not fail the transfer.
        tracing::warn!(transfer_id, error = %error, "upload complete but the .part link could not be removed");
    }
    Ok(Outbound::UploadComplete(FilesUploadComplete {
        transfer_id,
        name: state.dest_rel.rsplit('/').next().unwrap_or_default().to_string(),
        path: state.dest_rel,
        size: state.written,
    }))
}
```

> **`UploadComplete.name` vs `.path`.** `dest_rel` is the full wire path (e.g. `docs/note.txt`); the browser compares `name` (basename) against its local file and `path` against its listing. Both are set from the same string, no re-derivation from the filesystem.

- [ ] **Step 6: Run the tests — green**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked files::`
Expected: PASS — every session test above plus Task 4's 16 path/wire tests. Then run the whole suite (`cargo test --manifest-path apps/agent/Cargo.toml --locked`) to prove nothing else regressed.

- [ ] **Step 7: Clippy and the musl target**

Run: `cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`
Expected: clean — Task 4's `#[allow(dead_code)]` on `mod files;` in `main.rs` is still in place (Task 7 removes it once the dispatch consumes these items). The `#[cfg(test)]`-only helpers (`check_idle` etc. are `pub`, used by tests) are covered by the module-level allow until then.

Then: `cargo check --manifest-path apps/agent/Cargo.toml --locked --target x86_64-unknown-linux-musl`
Expected: builds — nothing in this task is desktop-gated.

- [ ] **Step 8: Commit**

```bash
git add apps/agent/src/files.rs
git commit -m "feat(agent): files session state machine, both directions"
```

> **Known follow-ups (record in the PR body, not fixed here):**
> 1. **Hard-link finalize is the no-replace mechanism.** `rename(2)` replaces on POSIX, so `hard_link` + `remove_file(part)` is the portable no-replace pair (Windows `rename` refuses to replace, which matches). On filesystems without hard links (some FAT mounts) the finalize fails `IO_ERROR` and the `.part` is cleaned — recorded, not worked around.
> 2. **Reused ids across directions.** `handle_cancel` matches the download first; an id reused for both directions can only be cancelled in the download's lifetime. The browser mints UUIDs per transfer (spec §2.5), so collision is out of scope; noted for review.
> 3. **`transfers.rs`/`FileClient` (web side) expects the ack stream `0,1,2,…`** from upload-begin and every accepted chunk — do not change that shape; the browser's window pump depends on it.

---

### Task 7: Agent — CLI, classification, the gate, and `run_files_session` (D3, part 4)

**Files:**
- Modify: `apps/agent/src/main.rs` (Cli flag; `SessionConfig`; `SessionMode` + `classify_offer`; `resolve_files_root`; `accepted_label`; the gate + `SessionMode::Files` arm in `run_one_session`; new `run_files_session`; extend the `classify_offer` test, add the gate test; remove the `#[allow(dead_code)]` on `mod files;`)
- Modify: `apps/agent/src/files.rs` (delete the three items that are dead once the dispatch consumes the module: `FilesError::not_found`, `Outbound::type_name`, `FilesRoot::path`; fix the two Task 4 test call sites that used `root.path()`. `FilesError::not_a_directory` stays — `resolve_parent_for_create` calls it)
- Modify: `apps/agent/src/rtc.rs` (remove the temporary `#[allow(dead_code)]` on `FILES_LABEL` — Task 5's placeholder; `classify_offer` and `accepted_label` are its first real users)

**Interfaces:**
- Consumes: Task 5's `rtc::{FILES_LABEL, send_approved_answer}`; Task 6's `files::{FilesSession, FilesRoot, decode_files_frame, extract_ids, frame_files, FilesError, FilesErrorCode}`; existing `rtc::{refuse_offer, flush_pending_candidates}`, `route_inbound`, `shutdown_signal`, `pty::now_ms`, `DataChannelEvent`.
- Produces (relied on by **Task 10**'s E2E; do not rename):
  - `SessionMode::Files`; `classify_offer` precedence terminal → desktop → files
  - `async fn resolve_files_root(files_root: Option<&str>) -> Option<files::FilesRoot>`
  - `async fn run_files_session(...)` — the files session loop
  - The exact refusal log line `refused: files root not configured or unusable` (E2E Task 10 asserts it)
  - Log lines `files session loop finished` (with `reason`) and, from Task 6, `files transfer cancelled` / `files transfer timed out`

> **The gate is the point (ADR-32), and it runs per offer.** In `run_one_session`, immediately after `build_peer` and **before** the mode dispatch match: resolve the root only for `SessionMode::Files`; when it is `None` (unset, missing, not a directory, unreadable — all one answer), `tracing::warn!` the exact line, `rtc::refuse_offer` (`approved: false`), `peer.close()`, `Ok(())`. A files offer therefore never reaches `answer_offer` (whose terminal-only check at `rtc.rs:722` stays untouched) and never reaches `send_approved_answer`.

> **One loop shape, copied from the terminal path.** The handshake (20 s, draining ICE candidates — they are what it is blocked on), the channel poll task forwarding raw text, a 64-capacity outbound frame channel with a single send point, the 1 h cap, `shutdown_signal`, and teardown (`session.teardown()` → drop `frame_tx` → `poll_task.abort()` → `peer.close()`). The differences: frames decode via `files::decode_files_frame` (not the terminal dispatcher), a 1 s `interval` drives `FilesSession::check_idle`, and there is no `PtyManager`.

> **BAD_FRAME on parse-but-invalid, drop on unparseable (spec §2.6).** `decode_files_frame` returns `Err` both when the envelope cannot be parsed at all and when a `files` payload fails validation. The loop distinguishes them with `extract_ids`: an id present ⇒ the JSON parsed ⇒ answer `files-error` `BAD_FRAME` with the id; no ids (oversize, garbage) ⇒ log at debug and drop.

- [ ] **Step 1: Write the failing tests**

In `apps/agent/src/main.rs`, extend the existing `classify_offer_maps_capabilities_to_a_session_mode` test (`:1979-1996`) — keep every current assertion and add the files cases at the end:

```rust
        // Week 10 (ADR-31): files is the lowest-precedence label; terminal
        // and desktop win when a malformed client offers more than one.
        assert_eq!(classify_offer(&["files".to_string()]), SessionMode::Files);
        assert_eq!(
            classify_offer(&["files".to_string(), "desktop".to_string()]),
            SessionMode::Desktop,
        );
        assert_eq!(
            classify_offer(&["files".to_string(), "terminal".to_string()]),
            SessionMode::Terminal,
        );
```

Then add the gate test beside it:

```rust
    #[tokio::test]
    async fn files_gate_closes_for_every_unusable_root() {
        // Unset → closed (ADR-32: no default).
        assert!(resolve_files_root(None).await.is_none());

        // Missing path → closed.
        let missing = std::env::temp_dir().join(format!("ponter-files-gate-missing-{}", std::process::id()));
        assert!(resolve_files_root(missing.to_str()).await.is_none());

        // A file, not a directory → closed.
        let file = std::env::temp_dir().join(format!("ponter-files-gate-file-{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        assert!(resolve_files_root(file.to_str()).await.is_none());
        std::fs::remove_file(&file).ok();

        // A real directory → open, and the root is resolved fresh each call
        // (never cached): removing it closes the gate again.
        let dir = std::env::temp_dir().join(format!("ponter-files-gate-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(resolve_files_root(dir.to_str()).await.is_some());
        std::fs::remove_dir_all(&dir).ok();
        assert!(resolve_files_root(dir.to_str()).await.is_none());
    }
```

- [ ] **Step 2: Run the tests — they must fail to compile**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked classify_offer files_gate`
Expected: FAIL — `SessionMode::Files` and `resolve_files_root` do not exist yet. TDD red state.

- [ ] **Step 3: Add the CLI flag, the config field, the mode, and the gate helper**

In `Cli` (after `allow_input`, `:105-113`):

```rust
    /// Directory served by files sessions. Unset = the files gate is closed
    /// (ADR-32); the root is resolved per offer, never cached at startup.
    #[arg(long, env = "AGENT_FILES_ROOT")]
    files_root: Option<String>,
```

In `SessionConfig` (`:394`), after `allow_input` (no `#[allow(dead_code)]` — this field is live on every target, including musl):

```rust
    /// The files sandbox root as configured (ADR-32). `None` closes the gate.
    files_root: Option<String>,
```

In the `SessionConfig` construction (`:462-473`):

```rust
        files_root: cli.files_root.clone(),
```

`SessionMode` (`:366-370`) gains the variant:

```rust
enum SessionMode {
    Terminal,
    Desktop,
    Files,
    None,
}
```

`classify_offer` (`:377-385`) gains the lowest-precedence branch:

```rust
fn classify_offer(capabilities: &[String]) -> SessionMode {
    if capabilities.iter().any(|c| c == rtc::TERMINAL_LABEL) {
        SessionMode::Terminal
    } else if capabilities.iter().any(|c| c == rtc::DESKTOP_LABEL) {
        SessionMode::Desktop
    } else if capabilities.iter().any(|c| c == rtc::FILES_LABEL) {
        SessionMode::Files
    } else {
        SessionMode::None
    }
}
```

And the gate helper, directly after `classify_offer`:

```rust
/// Resolve the operator's files root for one offer (ADR-32). `None` closes
/// the gate: unset, missing, not a directory, or unreadable are one answer —
/// the browser must not learn which. Evaluated **per offer**, never cached
/// (a root that disappears mid-run closes the gate for the next offer).
async fn resolve_files_root(files_root: Option<&str>) -> Option<files::FilesRoot> {
    let raw = files_root?;
    match files::FilesRoot::resolve(raw).await {
        Ok(root) => Some(root),
        Err(error) => {
            tracing::warn!(error = %error, "files root unusable");
            None
        }
    }
}
```

- [ ] **Step 4: Wire the gate, the label, and the dispatch arm**

In `run_one_session`, `accepted_label` (`:728-731`) becomes:

```rust
    let accepted_label = match mode {
        SessionMode::Desktop => rtc::CONTROL_LABEL.to_string(),
        SessionMode::Files => rtc::FILES_LABEL.to_string(),
        _ => rtc::TERMINAL_LABEL.to_string(),
    };
```

Then, immediately after the `build_peer` block (`:744-751`) and **before** the `match mode` dispatch (`:760`), insert the gate:

```rust
    // ADR-32: the files gate is evaluated per offer, before the answer. An
    // unset, missing, non-directory, or unreadable root is one refusal —
    // `approved: false` and the peer closed, with a log line the E2E pins.
    let files_root = if mode == SessionMode::Files {
        resolve_files_root(cfg.files_root.as_deref()).await
    } else {
        None
    };
    if mode == SessionMode::Files && files_root.is_none() {
        tracing::warn!(session_id = %offer.session_id, "refused: files root not configured or unusable");
        rtc::refuse_offer(&peer, offer, outbound).await?;
        let _ = peer.close().await;
        return Ok(());
    }
```

The dispatch match gains its arm (before `SessionMode::None`, which stays last):

```rust
        SessionMode::Files => {
            // The gate above guarantees `Some` for this arm.
            let root = files_root.expect("the files gate refused a rootless offer");
            return run_files_session(
                offer,
                &peer,
                outbound,
                pushed_ice,
                cfg,
                &mut pending,
                end_rx,
                end_tx,
                channel.clone(),
                open_rx,
                inbound,
                root,
            )
            .await;
        }
```

- [ ] **Step 5: Write `run_files_session` — handshake, poll task, session loop, teardown**

Add after `run_one_session` (before `CONTROL_OPEN_TIMEOUT`):

```rust
/// Serve a files offer end to end: answer, wait for the `files` channel,
/// then pump frames in both directions until the peer or the session ends.
///
/// The root is resolved and validated by the gate in `run_one_session`
/// (ADR-32); this function never re-checks it.
#[allow(clippy::too_many_arguments)]
async fn run_files_session(
    offer: &signal::SignalOffer,
    peer: &Arc<dyn PeerConnection>,
    outbound: &mpsc::Sender<signal::SignalMessage>,
    pushed_ice: &[signal::IceServerEntry],
    cfg: &SessionConfig,
    pending: &mut Vec<RTCIceCandidateInit>,
    mut end_rx: mpsc::Receiver<&'static str>,
    end_tx: mpsc::Sender<&'static str>,
    channel: Arc<OnceLock<Arc<dyn DataChannel>>>,
    mut open_rx: tokio::sync::oneshot::Receiver<()>,
    inbound: &mut mpsc::Receiver<signal::SignalMessage>,
    root: files::FilesRoot,
) -> Result<()> {
    // The gate already approved this offer; the answer carries `approved:
    // true` and the SDP. Files never reaches `answer_offer` (its terminal-
    // only approval at rtc.rs:722 is not consulted).
    rtc::send_approved_answer(peer, offer, outbound).await?;
    rtc::flush_pending_candidates(peer, pending).await?;

    // Wait for the channel to open, draining candidates the whole time —
    // identical shape to the terminal handshake (they are what it waits on).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        tokio::select! {
            biased;

            candidate = inbound.recv() => {
                let Some(message) = candidate else {
                    anyhow::bail!("the inbound channel closed while waiting for the files channel");
                };
                route_inbound(peer, &offer.session_id, pending, message, outbound, pushed_ice, cfg).await?;
            }

            reason = end_rx.recv() => {
                anyhow::bail!("the session ended during the handshake: {}", reason.unwrap_or("the peer went away"));
            }

            result = &mut open_rx => {
                result.context("the files channel was closed before it opened")?;
                break;
            }

            _ = tokio::time::sleep_until(deadline) => {
                anyhow::bail!("the files channel did not open within 20s");
            }
        }
    }

    let dc = channel.get().context("the files channel vanished after opening")?.clone();

    // One session owns the state machine; frames travel over these channels.
    // Capacity 64 mirrors the terminal path's frame channel.
    let mut session = files::FilesSession::new(root);
    let (frame_tx, mut frame_rx) = mpsc::channel::<String>(64);
    let (dispatch_tx, mut dispatch_rx) = mpsc::channel::<String>(64);

    // The poll task forwards raw text; the session loop decodes it. The
    // close event ends the session (the browser closed its last files tab,
    // or the stack reset the stream) — the same shape as the terminal poll
    // task, and the reason the ADR-14 slot frees immediately.
    let dc_for_events = dc.clone();
    let dispatch_tx_for_events = dispatch_tx.clone();
    let end_tx_for_events = end_tx.clone();
    let poll_task = tokio::spawn(async move {
        while let Some(event) = dc_for_events.poll().await {
            match event {
                DataChannelEvent::OnMessage(msg) => {
                    let Ok(text) = std::str::from_utf8(&msg.data) else {
                        tracing::debug!("ignoring a non-UTF-8 frame");
                        continue;
                    };
                    if dispatch_tx_for_events.send(text.to_string()).await.is_err() {
                        tracing::debug!("files dispatch channel is gone");
                        break;
                    }
                }
                DataChannelEvent::OnClose => {
                    let _ = end_tx_for_events.try_send("the files channel closed");
                    break;
                }
                _ => {}
            }
        }
    });

    // The poll task's clone is the only sender left, so `dispatch_rx.recv()`
    // returns `None` exactly when the poll task ends — the loop's exit arm.
    drop(dispatch_tx);

    // The single send point: drains outbound frames, sends each over the
    // channel. Backpressure on a slow consumer comes for free.
    let dc_for_pump = dc.clone();
    let mut pump = tokio::spawn(async move {
        while let Some(frame) = frame_rx.recv().await {
            if let Err(e) = dc_for_pump.send_text(&frame).await {
                tracing::debug!(error = %e, "files frame send failed");
                break;
            }
        }
    });

    // The 1 s idle tick: `FilesSession::check_idle` fails any transfer with
    // no chunk/ack progress for FILES_IDLE_TIMEOUT (30 s in production).
    let mut idle_tick = tokio::time::interval(Duration::from_secs(1));
    idle_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let session_deadline = tokio::time::Instant::now() + Duration::from_secs(3600);
    let reason = loop {
        tokio::select! {
            _ = &mut pump => break "the files pump ended",

            message = inbound.recv() => {
                match message {
                    Some(message) => route_inbound(peer, &offer.session_id, pending, message, outbound, pushed_ice, cfg).await?,
                    None => break "the agent is shutting down",
                }
            }

            raw = dispatch_rx.recv() => {
                let Some(raw) = raw else { break "the files dispatch channel closed" };
                for outbound_frame in handle_files_frame(&mut session, &raw).await {
                    let framed = files::frame_files(&outbound_frame, pty::now_ms());
                    if frame_tx.send(framed).await.is_err() {
                        tracing::debug!("files frame channel is gone");
                    }
                }
            }

            _ = idle_tick.tick() => {
                for outbound_frame in session.check_idle().await {
                    if frame_tx.send(files::frame_files(&outbound_frame, pty::now_ms())).await.is_err() {
                        tracing::debug!("files frame channel is gone");
                    }
                }
            }

            reason = end_rx.recv() => break reason.unwrap_or("the peer went away"),
            _ = tokio::time::sleep_until(session_deadline) => break "the 1h session cap",
            _ = shutdown_signal() => break "a shutdown signal",
        }
    };
    tracing::info!(session_id = %offer.session_id, reason, "files session loop finished");

    // Teardown (spec §2.6): cancel both directions, remove any `.part`, then
    // the same closing order as the terminal path.
    session.teardown().await;
    drop(frame_tx);
    poll_task.abort();
    let _ = peer.close().await;
    Ok(())
}

/// Decode one raw frame and turn it into outbound frames.
///
/// `decode_files_frame` errors both when the envelope cannot be parsed and
/// when a `files` payload fails validation; `extract_ids` distinguishes them
/// (an id present ⇒ the JSON parsed ⇒ `BAD_FRAME` with the id; nothing
/// extractable ⇒ log and drop, spec §2.6).
async fn handle_files_frame(session: &mut files::FilesSession, raw: &str) -> Vec<files::Outbound> {
    match files::decode_files_frame(raw) {
        Ok(Some(inbound)) => session.handle(inbound).await,
        Ok(None) => Vec::new(), // not a files frame: warn-and-ignore (ADR-09)
        Err(error) => {
            let (request_id, transfer_id) = files::extract_ids(raw);
            if request_id.is_none() && transfer_id.is_none() {
                tracing::debug!(error = %error, "dropping an unparseable frame");
                return Vec::new();
            }
            tracing::warn!(error = %error, "bad files frame");
            vec![files::FilesError::new(files::FilesErrorCode::BadFrame, "the frame could not be decoded")
                .with_ids(request_id, transfer_id)
                .into_frame()]
        }
    }
}
```

> **Why `handle_files_frame` is a free function, not a method.** `FilesSession::handle` takes `&mut self` and returns frames; the decode step must run before the borrow of `session` (and the error path never touches the session at all). Keeping it free also makes the BAD_FRAME attribution directly unit-testable without a channel.

- [ ] **Step 6: Remove the temporary allows and the dead items**

The dispatch now consumes the module, so the placeholder is gone. In `main.rs`, `mod files;` returns to its plain form:

```rust
mod files;
```

In `apps/agent/src/rtc.rs`, `FILES_LABEL` (Task 5's placeholder) drops its temporary allow — `classify_offer` and `accepted_label` are its first real users, so it is no longer dead:

```rust
pub const FILES_LABEL: &str = "files";
```

Then run `cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings` — it now flags the items Task 4 wrote that no non-test caller ever uses. Delete these three:

1. `FilesError::not_found` — no caller anywhere (the resolvers build `FilesError::new` directly). Note `not_a_directory` stays: `resolve_parent_for_create` calls it (Task 4).
2. `Outbound::type_name` — Task 6/7 never call it (tests match variants directly).
3. `FilesRoot::path` — no non-test caller; fix its two Task 4 test call sites:
   - `path_policy_rejects_empty_components_and_dots`: `std::fs::create_dir(root.path().join("a"))` → `std::fs::create_dir(dir.join("a"))`.
   - `upload_create_path_validates_parent_and_name`: `assert_eq!(parent, root.path().join("dir").canonicalize().unwrap())` → `assert_eq!(parent, dir.join("dir").canonicalize().unwrap())`.

If clippy names any other item, it is dead by the same rule — delete it or give it a real caller, whichever the item's spec role requires (there are none expected beyond the three).

- [ ] **Step 7: Run the full gate — tests, clippy, musl**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked`
Expected: PASS — the whole agent suite: Task 4's wire/path tests, Task 6's session tests, the extended `classify_offer` test, and `files_gate_closes_for_every_unusable_root`.

Run: `cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`
Expected: clean — this is the exact CI command (`build-agent.yml` Verify job). No `dead_code` allow remains anywhere in the files path; if it complains, Step 6 is incomplete.

Run: `cargo check --manifest-path apps/agent/Cargo.toml --locked --target x86_64-unknown-linux-musl`
Expected: builds — `run_files_session`, the gate, and the CLI flag are all ungated; `send_approved_answer` is ungated (Task 5); the desktop musl stub is untouched.

- [ ] **Step 8: Commit**

```bash
git add apps/agent/src/main.rs apps/agent/src/files.rs apps/agent/src/rtc.rs
git commit -m "feat(agent): files session gate, classification and dispatch"
```

> **Known follow-ups (record in the PR body, not fixed here):**
> 1. **The refusal happens before the answer, so the browser sees `approved: false` with a real SDP** — the same shape the `None`-mode refusal already uses. Task 10's gate-off E2E asserts `waitForChannel('files')` rejects and the agent log contains the exact line.
> 2. **The 1 s idle tick means a transfer can sit up to ~1 s past its 30 s deadline** before the timeout frame. The spec's 30 s is the no-progress bound, not a wall-clock guarantee; recorded so review does not read the tick as a precision loss.
> 3. **`handle_files_frame` attributes `BAD_FRAME` only when `extract_ids` finds an id.** An oversize frame with a well-formed `payload.transferId` inside still attributes — `extract_ids` parses with the guard bypassed (it never size-checks), which is deliberate: attribution is best-effort, never fatal.

---

### Task 8: `apps/web` — store: `files` tab kind, `openFilesTab`, file actions (D4, part 1)

**Files:**
- Modify: `apps/web/package.json` (add `@ponter/file-core` to `dependencies`; then `pnpm install` updates `pnpm-lock.yaml`)
- Modify: `apps/web/src/lib/connection-steps.ts` (widen the unions; add the `files` step list)
- Modify: `apps/web/src/stores/terminal.ts` (`TabItem`, `fileConnections`, `openFilesTab`, `closeTab`/`retryTab` branches, file actions)
- Create: `apps/web/src/lib/file-errors.ts` (code → UI text, spec §7.1)
- Create: `apps/web/src/lib/save-blob.ts` (the download save mechanism)
- Create: `apps/web/src/__tests__/files-store.test.ts`

**Interfaces:**
- Consumes: `FileClient`, `FilesError`, `FileListResult`, `TransferHandle`, `TransferProgress` (Task 3, `packages/file-core`); `FilesListResult`, `RemoteFile` (Task 1, `@ponter/shared`); the existing store internals (`createSignalingTransport` `terminal.ts:150-174`, `isTabOpen` `:119-121`, `recordFailedTab` `:438-466`, `recordDesktopErrorTab` `:471-487`, `discardDesktopConnection` `:737-742`, `closeDesktopConnection` `:745-753`, `runUnsubscribers` `:72-80`).
- Produces (relied on by **Task 9**):
  - `TabItem.kind: 'terminal' | 'desktop' | 'files'`; `TabItem.filesPath?: string`; `fileList?: FileListResult`; `fileError?: string | null`; `fileTransfers?: Array<TransferProgress & { handle: TransferHandle; name: string }>`
  - `InitStep` gains `'channel'`; `INIT_STEPS.files` (label `"Opening file channel"`); `stepIndex(kind: 'terminal' | 'desktop' | 'files', step)`
  - `openFilesTab(agentId: string, title?: string): Promise<string>`
  - `filesNavigate(tabId: string, path: string): Promise<void>`
  - `filesDownload(tabId: string, path: string): Promise<void>`
  - `filesUpload(tabId: string, file: File): Promise<void>`
  - `filesCancelTransfer(tabId: string, transferId: string): void`
  - `clearFileError(tabId: string): void`
  - `fileErrorMessage(code: FileClientErrorCode): string` (`@/lib/file-errors`)
  - `saveBlob(name: string, bytes: Uint8Array): void` (`@/lib/save-blob`)

> **Ruling — where the Blob save lives (spec §7.1 vs §7.2/§7.5).** §7.1 describes `FilesView` wrapping the resolved bytes in a `Blob` and clicking a synthetic `<a download>`; §7.5 pins "completion triggers the save" in the **store** test. Both hold when the store action resolves the handle and invokes a small save util (`@/lib/save-blob`, object URL + synthetic `<a download>` + revoke), which the store test spies on via `vi.mock('@/lib/save-blob')`, and `FilesView`'s file-row click is just `store.filesDownload(tabId, path)` (Task 9). The view never touches Blobs; the util is the single save path.

> **Ruling — the transfer entry carries `name`.** §7.2 pins `fileTransfers` as `Array<TransferProgress & { handle: TransferHandle }>`, but §7.1's footer must show a name for each active transfer. A view-local name map would lose names on remount and could not name transfers the view did not start, so the store entry is a strict superset: `TransferProgress & { handle: TransferHandle; name: string }` — everything §7.2 promises is present, and the extra field is what §7.1's footer renders.

> **Exclusivity is asymmetric (spec §7.2).** `openFilesTab` refuses when the agent has **any** tab (the `openDesktopTab` rule at `:503-511`, same message). `openDesktopTab` already refuses any tab — **no change**. `openTab` refuses only when the agent has a desktop tab (`:305-313`) — **extend** it to refuse when a files tab exists too, with a files-specific message. The three directions are pinned by tests below.

- [ ] **Step 1: Add the workspace dependency**

In `apps/web/package.json`, add to `dependencies` (alphabetical, after `@ponter/desktop-core`):

```json
    "@ponter/file-core": "workspace:*",
```

Run: `pnpm install`
Expected: lockfile updates; `apps/web` now links `@ponter/file-core` (created by Task 2).

- [ ] **Step 2: Write the failing store tests**

Create `apps/web/src/__tests__/files-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { useTerminalStore } from '../stores/terminal';
import type { TerminalSession } from '@ponter/terminal-core';
import type { RemoteFile } from '@ponter/shared';
import type { TransferProgress } from '@ponter/file-core';
import { saveBlob } from '@/lib/save-blob';

// The store builds a FileClient for every files tab. Mock the module so the
// test drives `list`/`download`/`upload` deterministically and can assert
// `dispose` (mirrors the desktop mock in terminal-store.test.ts:24-51).
const filesList = vi.fn();
const filesDownloadFn = vi.fn();
const filesUploadFn = vi.fn();
const filesDispose = vi.fn();
const filesCancel = vi.fn();

vi.mock('@ponter/file-core', () => {
  class MockFilesError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    FilesError: MockFilesError,
    FileClient: function (this: Record<string, unknown>) {
      this.list = filesList;
      this.download = filesDownloadFn;
      this.upload = filesUploadFn;
      this.dispose = filesDispose;
      this.onError = vi.fn(() => () => {});
    },
  };
});

vi.mock('@/services/client', () => ({
  apiClient: {
    sessions: {
      create: vi.fn(async () => ({ id: 'sess-files' })),
      terminate: vi.fn(async () => ({ success: true })),
    },
    webrtc: { getIceServers: vi.fn(async () => []) },
    http: { baseUrl: 'http://localhost', refreshAccessToken: vi.fn() },
  },
}));

const peerOptions: Array<Record<string, unknown>> = [];
const peerClose = vi.fn(async () => {});
const peerStart = vi.fn(async () => {});
let waitForChannelImpl: () => Promise<void> = async () => {};

vi.mock('@ponter/webrtc-core', () => ({
  PeerConnection: function (
    this: Record<string, unknown>,
    _rtcPeer: unknown,
    _transport: unknown,
    options: Record<string, unknown>,
  ) {
    peerOptions.push(options);
    this.start = peerStart;
    this.close = peerClose;
    this.waitForChannel = vi.fn(() => waitForChannelImpl());
    this.onConnectionStateChange = vi.fn(() => () => {});
    this.dataChannels = {};
  },
  createBrowserAdapter: vi.fn(() => ({})),
  RESTPollingTransport: function (this: Record<string, unknown>) {
    this.onServerError = vi.fn();
  },
  WebSocketSignalTransport: function (this: Record<string, unknown>) {
    this.onServerError = vi.fn();
  },
}));

vi.mock('@/services/token-storage', () => ({
  tokenStorage: { getAccessToken: vi.fn(async () => 'access-token') },
}));

vi.mock('@/lib/save-blob', () => ({ saveBlob: vi.fn() }));

/** A promise the test settles by hand, so progress can be asserted mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let downloadDone = deferred<Uint8Array | void>();
let uploadDone = deferred<Uint8Array | void>();
let downloadProgress: ((p: TransferProgress) => void) | null = null;
let uploadProgress: ((p: TransferProgress) => void) | null = null;

const entry = (overrides: Partial<RemoteFile> = {}): RemoteFile => ({
  name: 'notes.txt',
  path: 'notes.txt',
  size: 3,
  isDirectory: false,
  modifiedAt: '2026-10-04T00:00:00Z',
  ...overrides,
});

describe('files store (Week 10, spec §7.2/§7.5)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    peerOptions.length = 0;
    downloadDone = deferred<Uint8Array | void>();
    uploadDone = deferred<Uint8Array | void>();
    downloadProgress = null;
    uploadProgress = null;
    waitForChannelImpl = async () => {};
    filesList.mockReset();
    filesDownloadFn.mockReset();
    filesUploadFn.mockReset();
    filesDispose.mockReset();
    filesCancel.mockReset();
    peerClose.mockClear();
    peerStart.mockClear();
    vi.mocked(saveBlob).mockClear();

    filesList.mockResolvedValue({ path: '', entries: [], truncated: false });
    filesDownloadFn.mockImplementation(
      (_path: string, onProgress?: (p: TransferProgress) => void) => {
        downloadProgress = onProgress ?? null;
        return {
          transferId: 't-dl-1',
          direction: 'download',
          done: downloadDone.promise,
          cancel: filesCancel,
        };
      },
    );
    filesUploadFn.mockImplementation(
      (
        _dir: string,
        _name: string,
        _bytes: Uint8Array,
        onProgress?: (p: TransferProgress) => void,
      ) => {
        uploadProgress = onProgress ?? null;
        return {
          transferId: 't-up-1',
          direction: 'upload',
          done: uploadDone.promise,
          cancel: filesCancel,
        };
      },
    );
  });

  /**
   * Open a files tab whose handshake succeeds, with `list('')` resolving to
   * `entries`. Shared so the action tests do not repeat the setup block.
   */
  async function openFilesWithClient(entries: RemoteFile[] = []) {
    const store = useTerminalStore();
    filesList.mockResolvedValueOnce({ path: '', entries, truncated: false });
    const tabId = await store.openFilesTab('ag-1', 'Host 1');
    return { store, tabId };
  }

  it('openFilesTab offers one files channel and lists the root', async () => {
    const { store, tabId } = await openFilesWithClient([entry()]);

    expect(peerOptions.at(-1)).toMatchObject({
      channelLabels: ['files'],
      capabilities: ['files'],
    });
    expect(peerOptions.at(-1)).not.toHaveProperty('media');
    expect(filesList).toHaveBeenCalledWith('');

    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.kind).toBe('files');
    expect(tab?.status).toBe('active');
    expect(tab?.filesPath).toBe('');
    expect(tab?.fileList?.entries).toHaveLength(1);
    expect(tab?.initStep).toBeUndefined();
  });

  it('openFilesTab refuses when the agent already has any open tab', async () => {
    const { apiClient } = await import('@/services/client');
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-1',
      agentId: 'ag-1',
      kind: 'terminal',
      terminalId: 'term-1',
      title: 'Host 1',
      status: 'active',
      session: {} as unknown as TerminalSession,
    });
    vi.mocked(apiClient.sessions.create).mockClear();

    const tabId = await store.openFilesTab('ag-1', 'Host 1');

    expect(apiClient.sessions.create).not.toHaveBeenCalled();
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.status).toBe('error');
    expect(tab?.error).toMatch(/already has/i);
  });

  it('openTab refuses when a files tab exists (extended guard)', async () => {
    const { apiClient } = await import('@/services/client');
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-f-1',
      agentId: 'ag-3',
      kind: 'files',
      terminalId: '',
      title: 'Host 3',
      status: 'active',
      filesPath: '',
      fileList: { path: '', entries: [], truncated: false },
    });
    vi.mocked(apiClient.sessions.create).mockClear();

    const tabId = await store.openTab('ag-3', 'Host 3');

    expect(apiClient.sessions.create).not.toHaveBeenCalled();
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.status).toBe('error');
    expect(tab?.error).toMatch(/close the file transfer session/i);
  });

  it('openDesktopTab refuses when a files tab exists', async () => {
    const { apiClient } = await import('@/services/client');
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-f-1',
      agentId: 'ag-4',
      kind: 'files',
      terminalId: '',
      title: 'Host 4',
      status: 'active',
      filesPath: '',
      fileList: { path: '', entries: [], truncated: false },
    });
    vi.mocked(apiClient.sessions.create).mockClear();

    const tabId = await store.openDesktopTab('ag-4', 'Host 4');

    expect(apiClient.sessions.create).not.toHaveBeenCalled();
    expect(store.tabs.find((t) => t.id === tabId)?.error).toMatch(/already has/i);
  });

  it('pushes the tab before the handshake and releases an orphaned connection', async () => {
    const { apiClient } = await import('@/services/client');
    const store = useTerminalStore();
    const gate = deferred<void>();
    waitForChannelImpl = () => gate.promise;

    const openPromise = store.openFilesTab('ag-9', 'Host 9');
    // The tab exists before any await: a click shows progress immediately.
    expect(store.tabs).toHaveLength(1);
    const tabId = store.tabs[0]!.id;

    // The user closes it mid-handshake; the handshake then completes and the
    // freshly built connection must release itself (ADR-14 slot).
    store.closeTab(tabId);
    gate.resolve();
    await openPromise;

    expect(filesDispose).toHaveBeenCalled();
    expect(peerClose).toHaveBeenCalled();
    expect(apiClient.sessions.terminate).toHaveBeenCalledWith('sess-files');
    expect(filesList).not.toHaveBeenCalled();
    expect(store.tabs.find((t) => t.id === tabId)).toBeUndefined();
  });

  it('marks the tab failed with the combined refusal message', async () => {
    const store = useTerminalStore();
    waitForChannelImpl = async () => {
      throw new Error(
        'the agent refused the connection (one session per agent; another session is already active)',
      );
    };

    const tabId = await store.openFilesTab('ag-5', 'Host 5');

    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.status).toBe('error');
    // Spec §7.4: the hardcoded webrtc-core message is wrong for a gate
    // refusal, so the store shows the honest combined wording instead.
    expect(tab?.error).toMatch(/refused this session/i);
    expect(tab?.error).toMatch(/file access may not be configured/i);
  });

  it('filesNavigate lists the path and updates the tab', async () => {
    const { store, tabId } = await openFilesWithClient();
    filesList.mockResolvedValueOnce({
      path: 'docs',
      entries: [entry({ name: 'a.txt', path: 'docs/a.txt' })],
      truncated: true,
    });

    await store.filesNavigate(tabId, 'docs');

    expect(filesList).toHaveBeenLastCalledWith('docs');
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.filesPath).toBe('docs');
    expect(tab?.fileList?.truncated).toBe(true);
  });

  it('filesDownload wires progress into the tab and saves the blob on completion', async () => {
    const { store, tabId } = await openFilesWithClient();
    const bytes = new Uint8Array([1, 2, 3]);

    const pending = store.filesDownload(tabId, 'docs/notes.txt');
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(filesDownloadFn).toHaveBeenCalledWith(
      'docs/notes.txt',
      expect.any(Function),
    );
    expect(tab?.fileTransfers).toHaveLength(1);
    expect(tab?.fileTransfers?.[0]?.name).toBe('notes.txt');

    downloadProgress?.({
      transferId: 't-dl-1',
      direction: 'download',
      bytesTransferred: 3,
      totalBytes: 3,
      chunkIndex: 0,
    });
    await nextTick();
    expect(tab?.fileTransfers?.[0]?.bytesTransferred).toBe(3);

    downloadDone.resolve(bytes);
    await pending;

    expect(saveBlob).toHaveBeenCalledWith('notes.txt', bytes);
    expect(store.tabs.find((t) => t.id === tabId)?.fileTransfers).toHaveLength(0);
  });

  it('filesDownload maps a wire error code to the banner text', async () => {
    const { store, tabId } = await openFilesWithClient();
    const { FilesError } = await import('@ponter/file-core');
    const pending = store.filesDownload(tabId, 'a.bin');

    downloadDone.reject(new FilesError('TRANSFER_TIMEOUT', 'no progress'));
    await pending;

    expect(store.tabs.find((t) => t.id === tabId)?.fileError).toBe(
      'The transfer timed out',
    );
  });

  it('filesCancelTransfer calls the handle cancel and is not an error', async () => {
    const { store, tabId } = await openFilesWithClient();
    const { FilesError } = await import('@ponter/file-core');
    const pending = store.filesDownload(tabId, 'a.bin');

    store.filesCancelTransfer(tabId, 't-dl-1');
    expect(filesCancel).toHaveBeenCalledTimes(1);

    downloadDone.reject(new FilesError('CANCELLED', 'cancelled'));
    await pending;

    expect(store.tabs.find((t) => t.id === tabId)?.fileError).toBeNull();
    expect(store.tabs.find((t) => t.id === tabId)?.fileTransfers).toHaveLength(0);
  });

  it('filesUpload reads the picked file and creates an upload handle', async () => {
    const { store, tabId } = await openFilesWithClient();
    uploadDone.resolve(undefined);
    const file = new File([new Uint8Array([1, 2, 3])], 'up.bin');

    await store.filesUpload(tabId, file);

    expect(filesUploadFn).toHaveBeenCalledWith(
      '',
      'up.bin',
      expect.any(Uint8Array),
      expect.any(Function),
    );
    const bytes = filesUploadFn.mock.calls[0]?.[2] as Uint8Array;
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(store.tabs.find((t) => t.id === tabId)?.fileTransfers).toHaveLength(0);
  });

  it('closeTab disposes the client and settles an in-flight handle', async () => {
    const { store, tabId } = await openFilesWithClient();
    const { FilesError } = await import('@ponter/file-core');
    const pending = store.filesDownload(tabId, 'a.bin');

    // The real FileClient.dispose() rejects in-flight handles with
    // 'CANCELLED' (Task 3, client.test.ts); the fake honors that contract so
    // this pins that the store routes closeTab through dispose().
    filesDispose.mockImplementationOnce(() => {
      downloadDone.reject(new FilesError('CANCELLED', 'client disposed'));
    });
    store.closeTab(tabId);

    expect(filesDispose).toHaveBeenCalled();
    await pending;
    expect(store.tabs.find((t) => t.id === tabId)).toBeUndefined();
    expect(store.activeTabId).toBeNull();
  });

  it('clearFileError resets the banner', async () => {
    const { store, tabId } = await openFilesWithClient();
    const { FilesError } = await import('@ponter/file-core');
    const pending = store.filesDownload(tabId, 'a.bin');
    downloadDone.reject(new FilesError('NOT_FOUND', 'gone'));
    await pending;
    expect(store.tabs.find((t) => t.id === tabId)?.fileError).toBeTruthy();

    store.clearFileError(tabId);

    expect(store.tabs.find((t) => t.id === tabId)?.fileError).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/web test files-store`
Expected: FAIL — `store.openFilesTab is not a function` (and typecheck errors for the new imports). The file-core package must exist (Task 2) or the import itself fails — that is still the expected red.

- [ ] **Step 4: Implement**

**4a. `apps/web/src/lib/connection-steps.ts`** — widen the unions and add the files steps (spec §7.2). Replace the `InitStep` line and the `INIT_STEPS`/`stepIndex` blocks:

```typescript
export type InitStep =
  | 'session'
  | 'ice'
  | 'negotiating'
  | 'shell'
  | 'stream'
  | 'channel';
```

```typescript
export const INIT_STEPS: Record<
  'terminal' | 'desktop' | 'files',
  InitStepDef[]
> = {
  terminal: [
    { key: 'session', label: 'Creating session' },
    { key: 'ice', label: 'Preparing connection' },
    { key: 'negotiating', label: 'Negotiating WebRTC channel' },
    { key: 'shell', label: 'Opening shell' },
  ],
  desktop: [
    { key: 'session', label: 'Creating session' },
    { key: 'ice', label: 'Preparing connection' },
    { key: 'stream', label: 'Negotiating video stream' },
  ],
  files: [
    { key: 'session', label: 'Creating session' },
    { key: 'ice', label: 'Preparing connection' },
    { key: 'negotiating', label: 'Negotiating WebRTC channel' },
    { key: 'channel', label: 'Opening file channel' },
  ],
};

/** Index of `step` within the kind's step list; falls back to the first step. */
export function stepIndex(
  kind: 'terminal' | 'desktop' | 'files',
  step: InitStep,
): number {
  const idx = INIT_STEPS[kind].findIndex((s) => s.key === step);
  return idx === -1 ? 0 : idx;
}
```

**4b. `apps/web/src/lib/file-errors.ts`** (new) — the spec §7.1 mapping (`PATH_OUTSIDE_ROOT` → "The agent refused that path", `FILE_EXISTS` → "A file with that name already exists"):

```typescript
import type { FileClientErrorCode } from '@ponter/file-core';

/**
 * UI text per client error code (spec §7.1). The store maps `FilesError.code`
 * to one of these strings and puts it on `tab.fileError`; the view renders the
 * string, so no component needs to know the wire codes.
 */
export const FILE_ERROR_TEXT: Record<FileClientErrorCode, string> = {
  PATH_OUTSIDE_ROOT: 'The agent refused that path',
  INVALID_PATH: 'The agent refused that path',
  NOT_FOUND: 'That file or folder no longer exists',
  NOT_A_FILE: 'That entry is not a file',
  NOT_A_DIRECTORY: 'That entry is not a folder',
  FILE_EXISTS: 'A file with that name already exists',
  FILE_TOO_LARGE: 'That file is too large to transfer',
  TRANSFER_BUSY: 'Another transfer is already running in that direction',
  TRANSFER_UNKNOWN: 'The transfer is no longer known to the agent',
  TRANSFER_TIMEOUT: 'The transfer timed out',
  IO_ERROR: 'The agent could not complete the operation',
  BAD_FRAME: 'The agent rejected a malformed message',
  CANCELLED: 'Transfer cancelled',
};

export function fileErrorMessage(code: FileClientErrorCode): string {
  return FILE_ERROR_TEXT[code];
}
```

**4c. `apps/web/src/lib/save-blob.ts`** (new) — the single save path (ruling above; spec §7.1):

```typescript
/**
 * Save `bytes` to the user's downloads as `name` (spec §7.1): an object URL
 * plus a synthetic `<a download>` click, then the URL is revoked. In-memory by
 * design for the thin slice — the large-file/streaming watch item is §9.4.
 */
export function saveBlob(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes]));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
```

**4d. `apps/web/src/stores/terminal.ts`** — apply the following edits in order.

Edit 1 — imports. After the `@ponter/desktop-core` import (`:14`), add:

```typescript
import {
  FileClient,
  FilesError,
  type FileListResult,
  type TransferHandle,
  type TransferProgress,
} from '@ponter/file-core';
```

and after `import type { InitStep } from '@/lib/connection-steps';` (`:22`) add:

```typescript
import { fileErrorMessage } from '@/lib/file-errors';
import { saveBlob } from '@/lib/save-blob';
```

Edit 2 — `TabItem` (`:24-53`). Widen `kind` and append the files fields after `desktopInputEnabled`:

```typescript
  kind: 'terminal' | 'desktop' | 'files';
```

```typescript
  /** Files tabs only: true iff the agent's input gate is open (ADR-29). */
  desktopInputEnabled?: boolean;
  /** Files tabs only: current directory ('' = root, spec §7.2). */
  filesPath?: string;
  /** Files tabs only: the latest listing (spec §7.2). */
  fileList?: FileListResult;
  /** Files tabs only: last error text, mapped from `FilesError.code`. */
  fileError?: string | null;
  /** Files tabs only: active transfers with their handles (spec §7.2; `name`
   *  is what the §7.1 footer renders — see the ruling above). */
  fileTransfers?: Array<
    TransferProgress & { handle: TransferHandle; name: string }
  >;
```

Edit 3 — `setInitStep` (`:129-133`): widen the kind parameter to `'terminal' | 'desktop' | 'files'`.

Edit 4 — `fileConnections` map. After the `desktopConnections` block (`:99-107`) add:

```typescript
  // Files clients are kept apart like desktop ones: the tab holds only the
  // listing/transfer state; lifecycle stays here (spec §7.2).
  const fileConnections = new Map<
    string,
    {
      peer: PeerConnection;
      client: FileClient;
      sessionId: string;
      unsubscribers: Unsubscribe[];
    }
  >();
```

Edit 5 — `openTab` exclusivity (`:305-313`). Replace the guard with:

```typescript
    // ADR-14 guard, extended for Week 10: a files session holds the agent's
    // single slot too (spec §7.2), so it blocks a terminal like a desktop does.
    const blocking = tabs.value.find(
      (t) => t.agentId === agentId && t.kind !== 'terminal',
    );
    if (blocking) {
      recordFailedTab(
        tabId,
        agentId,
        title,
        blocking.kind === 'files'
          ? 'Close the file transfer session before opening a terminal.'
          : 'Close the desktop stream before opening a terminal.',
      );
      return tabId;
    }
```

Edit 6 — `recordFilesErrorTab`. After `recordDesktopErrorTab` (`:471-487`) add:

```typescript
  /** A files tab that shows a failure instead of a file browser. */
  function recordFilesErrorTab(
    tabId: string,
    agentId: string,
    title: string | undefined,
    message: string,
  ): void {
    tabs.value.push({
      id: tabId,
      agentId,
      kind: 'files',
      terminalId: '',
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'error',
      error: message,
    });
    activeTabId.value = tabId;
  }
```

Edit 7 — `openFilesTab`. Insert after `openDesktopTab` ends (`:682`), before `retryTab`:

```typescript
  /**
   * Open a files tab (Week 10, spec §7.2). Mirrors `openDesktopTab` step by
   * step: exclusivity first, tab pushed before the handshake, orphan release,
   * then the first `list('')` populates the view.
   */
  async function openFilesTab(agentId: string, title?: string): Promise<string> {
    const tabId = `tab-${crypto.randomUUID()}`;

    if (tabs.value.some((t) => t.agentId === agentId)) {
      recordFilesErrorTab(
        tabId,
        agentId,
        title,
        'This agent already has an open session tab (one session per agent). Close it first.',
      );
      return tabId;
    }

    tabs.value.push({
      id: tabId,
      agentId,
      kind: 'files',
      terminalId: '',
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'connecting',
      initStep: 'session',
      filesPath: '',
    });
    activeTabId.value = tabId;
    const live = tabs.value.find((t) => t.id === tabId);

    let sessionId: string | null = null;

    try {
      const sessionResp = await apiClient.sessions.create({ agentId });
      sessionId = sessionResp.id;
      const transport = await createSignalingTransport(sessionResp.id);
      if (live) live.initStep = 'ice';
      const iceServers = await apiClient.webrtc.getIceServers();
      const rtcPeer = createBrowserAdapter({ iceServers });

      const peer = new PeerConnection(rtcPeer, transport, {
        role: 'offerer',
        channelLabels: ['files'],
        capabilities: ['files'],
      });

      const unsubscribers: Unsubscribe[] = [];

      if (transport instanceof WebSocketSignalTransport) {
        unsubscribers.push(
          transport.onServerError((code) => {
            if (code !== 'SESSION_TERMINATED' && code !== 'NOT_FOUND') return;
            const message =
              code === 'SESSION_TERMINATED'
                ? 'Session terminated: the agent disconnected or the session was closed.'
                : 'Session not found on the server.';
            for (const tab of tabs.value) {
              if (tab.agentId !== agentId || tab.kind !== 'files') continue;
              tab.status = 'error';
              tab.error = message;
              tab.initStep = undefined;
            }
            discardFilesConnection(agentId);
          }),
        );
      }

      unsubscribers.push(
        peer.onConnectionStateChange((state) => {
          if (state !== 'failed') return;
          const message =
            'Connection failed: no direct route to the agent (ICE). Check that ' +
            'TURN is reachable, or that the agent is not behind a blocking NAT.';
          for (const tab of tabs.value) {
            if (tab.agentId !== agentId || tab.kind !== 'files') continue;
            tab.status = 'error';
            tab.error = message;
            tab.initStep = undefined;
          }
          discardFilesConnection(agentId);
        }),
      );

      await peer.start();
      if (live) live.initStep = 'negotiating';

      try {
        await peer.waitForChannel('files');
      } catch {
        // Spec §7.4: webrtc-core's hardcoded refusal message says "one session
        // per agent", which is wrong for a gate refusal (ADR-32) and
        // indistinguishable from one. Show the honest combined wording.
        throw new Error(
          'The agent refused this session. It may be busy (one session per agent) or file access may not be configured on the agent.',
        );
      }

      if (live) live.initStep = 'channel';
      const client = new FileClient(agentId, peer.dataChannels);
      fileConnections.set(agentId, {
        peer,
        client,
        sessionId: sessionResp.id,
        unsubscribers,
      });

      // The tab may have been closed while the handshake ran; `closeTab` found
      // no registered connection then, so release the one just built (ADR-14).
      if (!isTabOpen(tabId)) {
        client.dispose();
        void peer.close();
        runUnsubscribers(unsubscribers);
        fileConnections.delete(agentId);
        void apiClient.sessions.terminate(sessionResp.id).catch(() => {});
        return tabId;
      }

      const first = await client.list('');
      if (live) {
        live.fileList = first;
        live.filesPath = first.path;
        live.status = 'active';
        live.initStep = undefined;
      }
      return tabId;
    } catch (e) {
      const message = toErrorMessage(e);
      const half = fileConnections.get(agentId);
      if (half) {
        half.client.dispose();
        void half.peer.close();
        runUnsubscribers(half.unsubscribers);
        fileConnections.delete(agentId);
      }
      if (sessionId) {
        void apiClient.sessions.terminate(sessionId).catch(() => {
          // Best-effort: the session may already be gone server-side.
        });
      }
      if (live) {
        live.status = 'error';
        live.error = message;
        live.initStep = undefined;
      } else {
        recordFilesErrorTab(tabId, agentId, title, message);
      }
      return tabId;
    }
  }
```

Edit 8 — `retryTab` (`:691-724`): add the files branch before the terminal `else`:

```typescript
    } else if (failed.kind === 'files') {
      const conn = fileConnections.get(failed.agentId);
      if (conn) {
        conn.client.dispose();
        void conn.peer.close();
        runUnsubscribers(conn.unsubscribers);
        fileConnections.delete(failed.agentId);
        void apiClient.sessions.terminate(conn.sessionId).catch(() => {
          // Best-effort: the session may already be gone server-side.
        });
      }
      await openFilesTab(failed.agentId, failed.title);
    } else {
```

Edit 9 — teardown helpers. After `closeDesktopConnection` (`:745-753`) add:

```typescript
  /**
   * Drop a cached files connection and detach its subscriptions, without
   * touching the server session. Used by the error callbacks.
   */
  function discardFilesConnection(agentId: string): void {
    const conn = fileConnections.get(agentId);
    if (!conn) return;
    runUnsubscribers(conn.unsubscribers);
    fileConnections.delete(agentId);
  }

  /**
   * Close a files tab's connection: dispose the client (which rejects in-flight
   * handles with 'CANCELLED'), close the peer, release the session.
   */
  function closeFilesConnection(agentId: string): void {
    const conn = fileConnections.get(agentId);
    if (!conn) return;
    conn.client.dispose();
    void conn.peer.close();
    runUnsubscribers(conn.unsubscribers);
    fileConnections.delete(agentId);
    void apiClient.sessions.terminate(conn.sessionId).catch(() => {});
  }
```

Edit 10 — `closeTab` (`:806-810`) dispatch:

```typescript
    if (removed.kind === 'desktop') {
      closeDesktopConnection(removed.agentId);
    } else if (removed.kind === 'files') {
      closeFilesConnection(removed.agentId);
    } else {
      closeTerminalConnection(removed);
    }
```

Edit 11 — file actions. After `sendDesktopInput` (`:838-845`) add:

```typescript
  /** True when `cause` is the client's synthetic local cancel code. */
  function isCancelledError(cause: unknown): boolean {
    return cause instanceof FilesError && cause.code === 'CANCELLED';
  }

  /** Map a caught failure to banner text: wire code when known, else message. */
  function fileErrorText(cause: unknown): string {
    return cause instanceof FilesError
      ? fileErrorMessage(cause.code)
      : toErrorMessage(cause);
  }

  /** Update the tab's transfer entry from a progress callback. */
  function fileProgressHandler(tab: TabItem) {
    return (p: TransferProgress): void => {
      const entry = tab.fileTransfers?.find((t) => t.transferId === p.transferId);
      if (!entry) return;
      entry.bytesTransferred = p.bytesTransferred;
      entry.totalBytes = p.totalBytes;
      entry.chunkIndex = p.chunkIndex;
    };
  }

  /**
   * Register a handle on the tab and settle it: resolve with the save hook
   * (download) or nothing (upload), record non-cancel failures on the tab,
   * and drop the entry either way.
   */
  async function trackTransfer(
    tab: TabItem,
    handle: TransferHandle,
    name: string,
    onSaved?: (bytes: Uint8Array) => void,
  ): Promise<void> {
    tab.fileTransfers = [
      ...(tab.fileTransfers ?? []),
      {
        transferId: handle.transferId,
        direction: handle.direction,
        bytesTransferred: 0,
        totalBytes: 0,
        chunkIndex: -1,
        handle,
        name,
      },
    ];
    try {
      const bytes = (await handle.done) as Uint8Array | void;
      if (onSaved && bytes) onSaved(bytes);
    } catch (e) {
      if (!isCancelledError(e)) tab.fileError = fileErrorText(e);
    } finally {
      tab.fileTransfers = tab.fileTransfers?.filter(
        (t) => t.transferId !== handle.transferId,
      );
    }
  }

  /** List `path` and show it (spec §7.2). */
  async function filesNavigate(tabId: string, path: string): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'files') return;
    const conn = fileConnections.get(tab.agentId);
    if (!conn) return;
    tab.fileError = null;
    try {
      const result = await conn.client.list(path);
      tab.filesPath = result.path;
      tab.fileList = result;
    } catch (e) {
      tab.fileError = fileErrorText(e);
    }
  }

  /** Download `path` and save it on completion (spec §7.1/§7.2). */
  async function filesDownload(tabId: string, path: string): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'files') return;
    const conn = fileConnections.get(tab.agentId);
    if (!conn) return;
    tab.fileError = null;
    const name = path.split('/').pop() || path;
    const handle = conn.client.download(path, fileProgressHandler(tab));
    await trackTransfer(tab, handle, name, (bytes) => saveBlob(name, bytes));
  }

  /** Upload one picked file into the current directory (spec §7.2). */
  async function filesUpload(tabId: string, file: File): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'files') return;
    const conn = fileConnections.get(tab.agentId);
    if (!conn) return;
    tab.fileError = null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // The tab may have been closed while the file was read; the connection
    // would be disposed by now and the upload must not start.
    if (!isTabOpen(tabId)) return;
    const handle = conn.client.upload(
      tab.filesPath ?? '',
      file.name,
      bytes,
      fileProgressHandler(tab),
    );
    await trackTransfer(tab, handle, file.name);
  }

  /** Cancel one active transfer by id (idempotent). */
  function filesCancelTransfer(tabId: string, transferId: string): void {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'files') return;
    tab.fileTransfers
      ?.find((t) => t.transferId === transferId)
      ?.handle.cancel();
  }

  /** Dismiss the tab's error banner. */
  function clearFileError(tabId: string): void {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind === 'files') tab.fileError = null;
  }
```

Edit 12 — return object (`:847-860`): add the new actions:

```typescript
    openTab,
    openDesktopTab,
    openFilesTab,
    retryTab,
    setActiveTab,
    closeTab,
    selectDesktopSource,
    setDesktopBitrate,
    sendDesktopInput,
    filesNavigate,
    filesDownload,
    filesUpload,
    filesCancelTransfer,
    clearFileError,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/web test files-store && pnpm --filter @ponter/web typecheck`
Expected: PASS (12 tests), typecheck clean.

- [ ] **Step 6: Run the neighbouring suites for regressions**

Run: `pnpm --filter @ponter/web test terminal-store ConnectionProgress WorkspaceView DesktopView`
Expected: PASS — the widened unions are additive; `WorkspaceView`'s existing tests still mount.

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/lib/connection-steps.ts apps/web/src/lib/file-errors.ts apps/web/src/lib/save-blob.ts apps/web/src/stores/terminal.ts apps/web/src/__tests__/files-store.test.ts
git commit -m "feat(web): add files tab lifecycle and file transfer actions"
```

---
### Task 9: `apps/web` — FilesView, sidebar/tab-bar/dialogs, WorkspaceView branches (D4, part 2)

**Files:**
- Create: `apps/web/src/components/files/FilesView.vue`
- Modify: `apps/web/src/views/WorkspaceView.vue` (FilesView branch, widened progress/error conditions, `connect-files` wiring, footer)
- Modify: `apps/web/src/components/terminal/WorkspaceSidebar.vue` (`connectFiles` emit + button)
- Modify: `apps/web/src/components/terminal/TerminalTabBar.vue` (kind union + Folder icon)
- Modify: `apps/web/src/components/agent/RegisterAgentDialog.vue` (default capabilities)
- Modify: `apps/web/src/components/agent/EditAgentDialog.vue` (third toggle)
- Test: `apps/web/src/__tests__/FilesView.test.ts` (new), `ConnectionProgress.test.ts`, `WorkspaceView.test.ts`, `RegisterAgentDialog.test.ts`, `EditAgentDialog.test.ts`

**Interfaces:**
- Consumes (all produced by **Task 8**): `openFilesTab(agentId, title?)`; `filesNavigate(tabId, path)`; `filesDownload(tabId, path)`; `filesUpload(tabId, file: File)`; `filesCancelTransfer(tabId, transferId)`; `clearFileError(tabId)`; `TabItem.filesPath` / `fileList` (`FileListResult`) / `fileError` / `fileTransfers` (`Array<TransferProgress & { handle: TransferHandle; name: string }>`); `INIT_STEPS.files` with final label `"Opening file channel"`. Also `RemoteFile` from `@ponter/shared` (Task 1) and `TransferHandle` from `@ponter/file-core` (Task 3, test-only).
- Produces: the `files` UI — every remaining §7.1/§7.3 surface. `data-test` contract used by the tests below (and by any later E2E UI work): `files-view`, `files-up`, `files-refresh`, `files-crumb-root`, `files-crumb-{index}`, `files-upload`, `files-upload-input`, `files-row-{name}`, `files-error`, `files-error-dismiss`, `files-truncated`, `files-transfer-{transferId}`, `files-cancel-{transferId}`, `connect-files-{agentId}`, `edit-cap-files`.

> **Footer note (small, deliberate addition).** The bottom status bar currently prints `Channel: terminal (64 KiB buffer)` for every non-desktop tab (`WorkspaceView.vue:357`). Showing "terminal" for a files session is factually wrong, so a `files` branch is added beside the desktop one. §7.1 does not name the footer, but §7.4's honesty rule (say what is actually true) covers it; the WorkspaceView test pins the new text.

> **Gate-refusal empty state (§7.1).** The gate-refusal state is the full-body error overlay, which this task widens to `'files'` tabs — the overlay already renders the store's combined refusal message (Task 8). `FilesView` itself only needs the loading / empty-directory states.

- [ ] **Step 1: Write the failing `FilesView` tests**

Create `apps/web/src/__tests__/FilesView.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import FilesView from '@/components/files/FilesView.vue';
import { useTerminalStore } from '@/stores/terminal';
import type { TabItem } from '@/stores/terminal';
import type { RemoteFile } from '@ponter/shared';
import type { TransferHandle } from '@ponter/file-core';

const entry = (overrides: Partial<RemoteFile> = {}): RemoteFile => ({
  name: 'notes.txt',
  path: 'notes.txt',
  size: 3,
  isDirectory: false,
  modifiedAt: '2026-10-04T10:00:00Z',
  ...overrides,
});

/** A files tab already populated with a root listing (the store's steady state). */
function filesTab(overrides: Partial<TabItem> = {}): TabItem {
  return {
    id: 'tab-f1',
    agentId: 'ag-1',
    kind: 'files',
    terminalId: '',
    title: 'Host 1',
    status: 'active',
    filesPath: '',
    fileList: {
      path: '',
      entries: [
        entry({ name: 'docs', path: 'docs', isDirectory: true, size: 0 }),
        entry(),
      ],
      truncated: false,
    },
    ...overrides,
  };
}

const mountFiles = (overrides: Partial<TabItem> = {}) =>
  mount(FilesView, { props: { tab: filesTab(overrides) } });

describe('FilesView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders the listing with name, size and modified columns', () => {
    const wrapper = mountFiles();
    const text = wrapper.text();
    expect(text).toContain('docs');
    expect(text).toContain('notes.txt');
    // 3 bytes renders as "3 B" (the human formatter), not "3".
    expect(text).toContain('3 B');
    expect(text).toContain('Name');
    expect(text).toContain('Modified');
  });

  it('navigates into a directory on row click', async () => {
    const store = useTerminalStore();
    const navigate = vi.spyOn(store, 'filesNavigate').mockResolvedValue();
    const wrapper = mountFiles();

    await wrapper.find('[data-test="files-row-docs"]').trigger('click');

    expect(navigate).toHaveBeenCalledWith('tab-f1', 'docs');
  });

  it('downloads a file on row click', async () => {
    const store = useTerminalStore();
    const download = vi.spyOn(store, 'filesDownload').mockResolvedValue();
    const wrapper = mountFiles();

    await wrapper.find('[data-test="files-row-notes.txt"]').trigger('click');

    expect(download).toHaveBeenCalledWith('tab-f1', 'notes.txt');
  });

  it('disables the up button at the root and walks up from a subdirectory', async () => {
    const atRoot = mountFiles();
    expect(
      atRoot.find('[data-test="files-up"]').attributes('disabled'),
    ).toBeDefined();

    const store = useTerminalStore();
    const navigate = vi.spyOn(store, 'filesNavigate').mockResolvedValue();
    const nested = mountFiles({
      filesPath: 'docs/sub',
      fileList: { path: 'docs/sub', entries: [], truncated: false },
    });
    const up = nested.find('[data-test="files-up"]');
    expect(up.attributes('disabled')).toBeUndefined();

    await up.trigger('click');
    expect(navigate).toHaveBeenCalledWith('tab-f1', 'docs');
  });

  it('renders clickable breadcrumb segments', async () => {
    const store = useTerminalStore();
    const navigate = vi.spyOn(store, 'filesNavigate').mockResolvedValue();
    const wrapper = mountFiles({
      filesPath: 'docs/sub',
      fileList: { path: 'docs/sub', entries: [], truncated: false },
    });

    expect(wrapper.text()).toContain('docs');
    expect(wrapper.text()).toContain('sub');

    await wrapper.find('[data-test="files-crumb-root"]').trigger('click');
    expect(navigate).toHaveBeenCalledWith('tab-f1', '');
  });

  it('reads the picked file from the hidden input and calls filesUpload', async () => {
    const store = useTerminalStore();
    const upload = vi.spyOn(store, 'filesUpload').mockResolvedValue();
    const wrapper = mountFiles();

    const input = wrapper.find<HTMLInputElement>(
      '[data-test="files-upload-input"]',
    );
    expect(input.attributes('type')).toBe('file');

    const file = new File([new Uint8Array([1, 2, 3])], 'up.bin');
    Object.defineProperty(input.element, 'files', {
      value: [file],
      configurable: true,
    });
    await input.trigger('change');

    expect(upload).toHaveBeenCalledWith('tab-f1', file);
  });

  it('shows each active transfer with its percent and cancels from the footer', async () => {
    const store = useTerminalStore();
    const cancel = vi
      .spyOn(store, 'filesCancelTransfer')
      .mockImplementation(() => {});
    const handle: TransferHandle = {
      transferId: 't-dl-1',
      direction: 'download',
      done: Promise.resolve(),
      cancel: vi.fn(),
    };
    const wrapper = mountFiles({
      fileTransfers: [
        {
          transferId: 't-dl-1',
          direction: 'download',
          bytesTransferred: 50,
          totalBytes: 100,
          chunkIndex: 0,
          name: 'big.bin',
          handle,
        },
      ],
    });

    const line = wrapper.find('[data-test="files-transfer-t-dl-1"]');
    expect(line.text()).toContain('big.bin');
    expect(line.text()).toContain('50%');

    await line.find('[data-test="files-cancel-t-dl-1"]').trigger('click');
    expect(cancel).toHaveBeenCalledWith('tab-f1', 't-dl-1');
  });

  it('renders the store-mapped error text and dismisses the banner', async () => {
    const store = useTerminalStore();
    const clear = vi.spyOn(store, 'clearFileError').mockImplementation(() => {});
    const wrapper = mountFiles({
      fileError: 'A file with that name already exists',
    });

    const banner = wrapper.find('[data-test="files-error"]');
    expect(banner.text()).toContain('A file with that name already exists');

    await wrapper.find('[data-test="files-error-dismiss"]').trigger('click');
    expect(clear).toHaveBeenCalledWith('tab-f1');
  });

  it('notes a truncated listing and the empty-directory state', () => {
    const truncated = mountFiles({
      fileList: { path: '', entries: [], truncated: true },
    });
    expect(truncated.find('[data-test="files-truncated"]').exists()).toBe(true);
    expect(truncated.text()).toContain('empty');

    const empty = mountFiles({
      fileList: { path: '', entries: [], truncated: false },
    });
    expect(empty.find('[data-test="files-truncated"]').exists()).toBe(false);
    expect(empty.text()).toContain('empty');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ponter/web test FilesView`
Expected: FAIL — `Failed to resolve import "@/components/files/FilesView.vue"`.

- [ ] **Step 3: Implement `FilesView.vue`**

Create `apps/web/src/components/files/FilesView.vue`:

```vue
<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ArrowUp,
  File as FileIcon,
  Folder,
  RefreshCw,
  Upload,
  X,
} from '@lucide/vue';
import { useTerminalStore } from '@/stores/terminal';
import type { TabItem } from '@/stores/terminal';
import type { RemoteFile } from '@ponter/shared';

const props = defineProps<{ tab: TabItem }>();
const store = useTerminalStore();

const fileInput = ref<HTMLInputElement | null>(null);

const currentPath = computed(() => props.tab.filesPath ?? '');
const segments = computed(() => currentPath.value.split('/').filter(Boolean));
const atRoot = computed(() => currentPath.value === '');
const entries = computed(() => props.tab.fileList?.entries ?? []);
const transfers = computed(() => props.tab.fileTransfers ?? []);

/** Human sizes per spec §7.1: B / KiB / MiB / GiB, one decimal from KiB up. */
function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ['KiB', 'MiB', 'GiB'] as const;
  let value = size;
  let unit: (typeof units)[number] = 'KiB';
  for (const u of units) {
    unit = u;
    value /= 1024;
    if (value < 1024) break;
  }
  return `${value.toFixed(1)} ${unit}`;
}

function formatModified(iso: string): string {
  return new Date(iso).toLocaleString();
}

function percentOf(t: { bytesTransferred: number; totalBytes: number }): number {
  if (t.totalBytes <= 0) return 0;
  return Math.min(100, Math.floor((t.bytesTransferred / t.totalBytes) * 100));
}

function parentPath(): string {
  const parts = segments.value.slice(0, -1);
  return parts.join('/');
}

function navigate(path: string): void {
  void store.filesNavigate(props.tab.id, path);
}

function onRowClick(entry: RemoteFile): void {
  if (entry.isDirectory) navigate(entry.path);
  else void store.filesDownload(props.tab.id, entry.path);
}

function refresh(): void {
  navigate(currentPath.value);
}

function onUploadClick(): void {
  fileInput.value?.click();
}

function onFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // Reset so picking the same file again still fires `change`.
  input.value = '';
  if (file) void store.filesUpload(props.tab.id, file);
}
</script>

<template>
  <div data-test="files-view" class="flex h-full min-h-0 flex-col">
    <!-- Toolbar: up / refresh / breadcrumb / upload -->
    <div
      class="flex h-9 flex-shrink-0 items-center gap-2 border-b border-border px-3 text-xs"
    >
      <button
        data-test="files-up"
        class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
        title="Up one level"
        aria-label="Up one level"
        :disabled="atRoot"
        @click="navigate(parentPath())"
      >
        <ArrowUp class="w-3.5 h-3.5" />
      </button>
      <button
        data-test="files-refresh"
        class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Refresh listing"
        aria-label="Refresh listing"
        @click="refresh()"
      >
        <RefreshCw class="w-3.5 h-3.5" />
      </button>

      <nav
        class="flex min-w-0 flex-1 items-center gap-1 font-mono"
        aria-label="Current path"
      >
        <button
          data-test="files-crumb-root"
          class="flex-shrink-0 hover:text-foreground"
          :class="atRoot ? 'text-foreground' : 'text-muted-foreground'"
          @click="navigate('')"
        >
          root
        </button>
        <template v-for="(segment, index) in segments" :key="`${index}-${segment}`">
          <span class="flex-shrink-0 text-muted-foreground">/</span>
          <button
            :data-test="`files-crumb-${index}`"
            class="truncate"
            :class="
              index === segments.length - 1
                ? 'text-foreground'
                : 'text-muted-foreground'
            "
            @click="navigate(segments.slice(0, index + 1).join('/'))"
          >
            {{ segment }}
          </button>
        </template>
      </nav>

      <button
        data-test="files-upload"
        class="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        @click="onUploadClick()"
      >
        <Upload class="w-3.5 h-3.5" />
        Upload
      </button>
      <!-- Hidden picker: one file per pick, uploaded into the current dir. -->
      <input
        ref="fileInput"
        data-test="files-upload-input"
        type="file"
        class="hidden"
        @change="onFilePicked"
      />
    </div>

    <!-- Error banner: the store maps FilesError.code to this text (§7.1). -->
    <div
      v-if="tab.fileError"
      data-test="files-error"
      role="alert"
      class="flex flex-shrink-0 items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
    >
      <span class="truncate">{{ tab.fileError }}</span>
      <button
        data-test="files-error-dismiss"
        class="flex-shrink-0 rounded p-0.5 hover:bg-destructive/20"
        aria-label="Dismiss error"
        @click="store.clearFileError(tab.id)"
      >
        <X class="w-3.5 h-3.5" />
      </button>
    </div>

    <!-- Listing -->
    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full text-xs">
        <thead
          class="sticky top-0 bg-card/95 text-left text-muted-foreground"
        >
          <tr>
            <th class="px-3 py-1.5 font-medium">Name</th>
            <th class="w-24 px-3 py-1.5 text-right font-medium">Size</th>
            <th class="w-48 px-3 py-1.5 font-medium">Modified</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in entries"
            :key="entry.path"
            :data-test="`files-row-${entry.name}`"
            class="cursor-pointer border-t border-border/50 hover:bg-muted/50"
            @click="onRowClick(entry)"
          >
            <td class="px-3 py-1.5">
              <span class="flex items-center gap-2">
                <Folder
                  v-if="entry.isDirectory"
                  class="w-3.5 h-3.5 flex-shrink-0 text-primary"
                />
                <FileIcon
                  v-else
                  class="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground"
                />
                <span class="truncate">{{ entry.name }}</span>
              </span>
            </td>
            <td
              class="px-3 py-1.5 text-right font-mono text-muted-foreground"
            >
              {{ entry.isDirectory ? '—' : formatSize(entry.size) }}
            </td>
            <td class="px-3 py-1.5 font-mono text-muted-foreground">
              {{ formatModified(entry.modifiedAt) }}
            </td>
          </tr>
        </tbody>
      </table>

      <p
        v-if="!tab.fileList"
        class="p-6 text-center text-xs text-muted-foreground"
      >
        Loading…
      </p>
      <p
        v-else-if="entries.length === 0"
        class="p-6 text-center text-xs text-muted-foreground"
      >
        This folder is empty
      </p>

      <p
        v-if="tab.fileList?.truncated"
        data-test="files-truncated"
        class="px-3 py-1.5 text-[11px] text-amber-500"
      >
        Listing truncated: showing the first 4096 entries.
      </p>
    </div>

    <!-- Transfer footer: one line per active transfer, with cancel (§7.1). -->
    <div
      v-if="transfers.length"
      class="flex-shrink-0 space-y-1 border-t border-border px-3 py-1.5"
    >
      <div
        v-for="t in transfers"
        :key="t.transferId"
        :data-test="`files-transfer-${t.transferId}`"
        class="flex items-center gap-2 text-xs font-mono"
      >
        <span class="text-muted-foreground">
          {{ t.direction === 'download' ? '↓' : '↑' }}
        </span>
        <span class="max-w-[220px] truncate">{{ t.name }}</span>
        <span class="text-muted-foreground">{{ percentOf(t) }}%</span>
        <button
          :data-test="`files-cancel-${t.transferId}`"
          class="rounded p-0.5 text-muted-foreground hover:text-destructive"
          :aria-label="`Cancel transfer of ${t.name}`"
          @click="store.filesCancelTransfer(tab.id, t.transferId)"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 4: Run the FilesView tests to verify they pass**

Run: `pnpm --filter @ponter/web test FilesView`
Expected: PASS (9 tests).

- [ ] **Step 5: WorkspaceView, sidebar, tab bar, dialogs**

**5a. `apps/web/src/views/WorkspaceView.vue`**

Edit 1 — import: after the `DesktopView` import add:

```typescript
import FilesView from '@/components/files/FilesView.vue';
```

Edit 2 — handler: after `handleConnectDesktop` add:

```typescript
function handleConnectFiles(agent: Agent) {
  terminalStore.openFilesTab(
    agent.id,
    agent.hostname || `Agent ${agent.id.slice(0, 6)}`,
  );
}
```

Edit 3 — sidebar wiring:

```vue
    <WorkspaceSidebar
      v-show="sidebarOpen"
      @connect-agent="handleConnect"
      @connect-desktop="handleConnectDesktop"
      @connect-files="handleConnectFiles"
    />
```

Edit 4 — the `FilesView` branch, after the `DesktopView` block:

```vue
          <FilesView
            v-else-if="terminalStore.activeTab.kind === 'files'"
            :key="terminalStore.activeTab.id"
            :tab="terminalStore.activeTab as TabItem"
          />
```

Edit 5 — widen the `ConnectionProgress` condition (and its comment):

```vue
          <!-- The step list overlays the body while a terminal or files
               handshake runs, including the final stage after the session
               exists — xterm is already mounted underneath, so the first PTY
               output flips the tab active and reveals it. (Desktop owns its own
               progress overlay inside DesktopView, next to its error overlay.)
               A failed tab shows the error overlay below instead. -->
          <ConnectionProgress
            v-if="
              (terminalStore.activeTab.kind === 'terminal' ||
                terminalStore.activeTab.kind === 'files') &&
              terminalStore.activeTab.status === 'connecting'
            "
            :tab="terminalStore.activeTab as TabItem"
          />
```

Edit 6 — widen the error-overlay condition:

```vue
          <div
            v-if="
              (terminalStore.activeTab.kind === 'terminal' ||
                terminalStore.activeTab.kind === 'files') &&
              terminalStore.activeTab.status === 'error'
            "
```

Edit 7 — footer channel line: replace `<span v-else>Channel: terminal (64 KiB buffer)</span>` with:

```vue
            <span v-else-if="terminalStore.activeTab.kind === 'files'">
              Channel: files (64 KiB buffer)
            </span>
            <span v-else>Channel: terminal (64 KiB buffer)</span>
```

**5b. `apps/web/src/components/terminal/WorkspaceSidebar.vue`**

- Import: `import { Terminal, Monitor, Folder, RefreshCw, Server, Search } from '@lucide/vue';`
- Emits block gains:

```typescript
  (e: 'connectFiles', agent: Agent): void;
```

- After the desktop button (`:151-160`) add:

```vue
            <button
              v-if="a.capabilities.includes('files')"
              class="p-1 rounded bg-muted/50 hover:bg-primary/10 hover:text-primary transition-colors text-muted-foreground"
              title="Browse files"
              :aria-label="`Browse files on ${a.hostname || a.id}`"
              :data-test="`connect-files-${a.id}`"
              @click="$emit('connectFiles', a)"
            >
              <Folder class="w-3.5 h-3.5" />
            </button>
```

**5c. `apps/web/src/components/terminal/TerminalTabBar.vue`**

- Import: `import { Plus, RefreshCw, X, Terminal, Monitor, Folder, Loader2 } from '@lucide/vue';`
- Kind prop (`:11`): `kind: 'terminal' | 'desktop' | 'files';`
- Icon branch (`:64-68`):

```vue
          <Monitor
            v-if="tab.kind === 'desktop'"
            class="w-3.5 h-3.5 flex-shrink-0"
          />
          <Folder
            v-else-if="tab.kind === 'files'"
            class="w-3.5 h-3.5 flex-shrink-0"
          />
          <Terminal v-else class="w-3.5 h-3.5 flex-shrink-0" />
```

**5d. `apps/web/src/components/agent/RegisterAgentDialog.vue:95`**

```typescript
      capabilities: ['terminal', 'desktop', 'files'],
```

**5e. `apps/web/src/components/agent/EditAgentDialog.vue`**

- Import: add `Folder` to the `@lucide/vue` list.
- `:33`:

```typescript
const TOGGLEABLE_CAPABILITIES = ['terminal', 'desktop', 'files'] as const;
```

- Comment at `:79-80` is now stale ("never silently drops e.g. a future 'files' capability" — files is managed now). Replace with:

```typescript
  // Preserve any capability this dialog does not manage, so editing hostname
  // never silently drops an unrecognized one.
```

- After the desktop toggle button (`:248-263`) add:

```vue
              <button
                type="button"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all"
                :class="
                  capabilities.includes('files')
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-card hover:bg-secondary/60 text-muted-foreground'
                "
                :aria-pressed="capabilities.includes('files')"
                :disabled="loading"
                data-test="edit-cap-files"
                @click="toggleCapability('files')"
              >
                <Folder class="w-3.5 h-3.5" />
                Files
              </button>
```

- [ ] **Step 6: Update and add the remaining component tests**

**6a. `ConnectionProgress.test.ts`** — add after the desktop test:

```typescript
  it('renders the files-specific final step', () => {
    const wrapper = mount(ConnectionProgress, {
      props: {
        tab: tab({ kind: 'files', initStep: 'channel', title: 'Host F' }),
      },
    });

    const text = wrapper.text();
    expect(text).toContain('Opening file channel');
    expect(text).not.toContain('Opening shell');

    const items = wrapper.findAll('li');
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.attributes('data-state'))).toEqual([
      'done',
      'done',
      'done',
      'active',
    ]);
  });
```

**6b. `RegisterAgentDialog.test.ts:119`** — the expected capabilities become:

```typescript
      capabilities: ['terminal', 'desktop', 'files'],
```

**6c. `EditAgentDialog.test.ts`** — test 2 gains (after the desktop check at `:69-71`):

```typescript
    expect(
      wrapper.find('[data-test="edit-cap-files"]').attributes('aria-pressed'),
    ).toBe('false');
```

and test 4 becomes a three-capability submit: the mock `updated` agent (`:92-95`) gets `capabilities: ['terminal', 'desktop', 'files']`, the click sequence (`:104`) gains:

```typescript
    await wrapper.find('[data-test="edit-cap-files"]').trigger('click');
```

and the expectation (`:108-114`) becomes:

```typescript
    expect(apiClient.agents.update).toHaveBeenCalledWith('agent-1', {
      hostname: 'new-host',
      platform: 'linux',
      osVersion: '22.04',
      agentVersion: '0.1.0',
      capabilities: ['terminal', 'desktop', 'files'],
    });
```

**6d. `WorkspaceView.test.ts`** — add after the DesktopView test (`:165-180`) (this pins the widened conditions; §7.5 lists it as optional, the change is glue worth a test):

```typescript
  it('renders FilesView and the files channel footer for a files tab', async () => {
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-f',
      agentId: 'ag-1',
      kind: 'files',
      terminalId: '',
      title: 'Host 1',
      status: 'active',
      filesPath: '',
      fileList: {
        path: '',
        entries: [
          {
            name: 'notes.txt',
            path: 'notes.txt',
            size: 3,
            isDirectory: false,
            modifiedAt: '2026-10-04T10:00:00Z',
          },
        ],
        truncated: false,
      },
    });
    store.setActiveTab('tab-f');

    const wrapper = mountWorkspace();
    await flushPromises();

    expect(wrapper.find('[data-test="files-view"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('notes.txt');
    // The footer must not claim a terminal channel for a files session.
    expect(wrapper.text()).toContain('Channel: files (64 KiB buffer)');
  });

  it('shows the error overlay, not the stepper, for a failed files tab', async () => {
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-fe',
      agentId: 'ag-1',
      kind: 'files',
      terminalId: '',
      title: 'Host 1',
      status: 'error',
      error: 'The agent refused this session.',
    });
    store.setActiveTab('tab-fe');

    const wrapper = mountWorkspace();
    await flushPromises();

    expect(wrapper.text()).toContain('The agent refused this session.');
    expect(wrapper.text()).not.toContain('Connecting to');
  });
```

- [ ] **Step 7: Run the touched suites**

Run: `pnpm --filter @ponter/web test FilesView ConnectionProgress WorkspaceView RegisterAgentDialog EditAgentDialog`
Expected: PASS (all five suites; the previously existing tests unchanged in behaviour).

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @ponter/web typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/files/FilesView.vue apps/web/src/views/WorkspaceView.vue apps/web/src/components/terminal/WorkspaceSidebar.vue apps/web/src/components/terminal/TerminalTabBar.vue apps/web/src/components/agent/RegisterAgentDialog.vue apps/web/src/components/agent/EditAgentDialog.vue apps/web/src/__tests__/FilesView.test.ts apps/web/src/__tests__/ConnectionProgress.test.ts apps/web/src/__tests__/WorkspaceView.test.ts apps/web/src/__tests__/RegisterAgentDialog.test.ts apps/web/src/__tests__/EditAgentDialog.test.ts
git commit -m "feat(web): add files browser view and files capability UI"
```

---
### Task 10: E2E — cross-language files suite + harness helpers (D5)

**Files:**
- Modify: `packages/webrtc-core/test/e2e/harness.ts` (`openFilesPeer` + `waitForFilesFrame` helpers; a `FilesFrame` type alias)
- Create: `packages/webrtc-core/test/e2e/files.e2e.test.ts`

**Interfaces:**
- Consumes: `packages/file-core`'s client is **not** used here — this suite speaks the raw wire (spec §8.3), so it consumes the Task 1 payload types from `@ponter/shared` (`FilesListRequest`, `FilesListResult`, `FilesDownloadRequest`, `FilesDownloadBegin`, `FilesDownloadEnd`, `FilesUploadBeginRequest`, `FilesUploadEndRequest`, `FilesUploadComplete`, `FilesAckMessage`, `FilesCancelMessage`, `FilesErrorMessage`, `FilesErrorCode`, `FileChunkMessage`, `RemoteFile`) and the existing harness (`seed`, `spawnAgent`, `waitForAgentOnline`, `openTerminalPeer` as the pattern, `pollUntil` internals via `waitFor`, `agents`, `frameBytes`). The agent side is Task 7's implementation (gate refusal log `refused: files root not configured or unusable`; cancel log `files transfer cancelled`).
- Produces: `openFilesPeer(transport)` and `waitForFilesFrame(frames, predicate, description)` for any later files E2E work. The suite is picked up by the existing `vitest.e2e.config.ts` include and the existing `ci-e2e.yml` job — **no workflow change** (spec §8.5).

> **Frame-type source of truth.** All `type` strings and payload shapes come from Task 1's `packages/shared/src/types/files.ts`; this file imports the payload types but writes the `type` strings literally (`'files-list'`, …) exactly as Task 1 declares them — if a name mismatches, the suite fails to compile, which is the desired pin.

- [ ] **Step 1: Add the harness helpers (no test yet — the helper itself is exercised by the suite below)**

Append to `packages/webrtc-core/test/e2e/harness.ts` (after `openTerminalPeer`, `:543-575`):

```typescript
/** A frame on the `files` channel, as received by the offerer. */
export type FilesFrame = DataChannelMessage<Record<string, unknown>>;

/**
 * Create and start a PeerConnection with the 'files' channel (spec §8.3),
 * buffering received frames. Mirrors `openTerminalPeer`.
 */
export async function openFilesPeer(transport: SignalTransport): Promise<{
  offerer: PeerConnection;
  frames: FilesFrame[];
}> {
  const offerer = new PeerConnection(
    new WeriftAdapter({ iceServers: [] }),
    transport,
    { role: 'offerer', channelLabels: ['files'], capabilities: ['files'] },
  );

  const frames: FilesFrame[] = [];
  offerer.dataChannels.onMessage<Record<string, unknown>>('files', (msg) => {
    frames.push(msg);
  });

  try {
    await offerer.start();
    const channel = await offerer.waitForChannel('files', 20_000);
    expect(channel.readyState).toBe('open');

    return { offerer, frames };
  } catch (err) {
    const agentLogs = agents
      .map((a, i) => `=== AGENT #${i} ===\n${a.output()}`)
      .join('\n');
    const serverLogs = serverOutput();
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n` +
        `--- AGENT LOGS ---\n${agentLogs}\n` +
        `--- SERVER LOGS ---\n${serverLogs}`,
    );
  }
}

/**
 * Poll `frames` until `predicate` matches one, and fail with `description`
 * (plus the last frames seen) after `timeoutMs`. The shared waiter keeps the
 * per-test polling blocks out of the suite (Sonar duplication budget).
 */
export async function waitForFilesFrame(
  frames: FilesFrame[],
  predicate: (frame: FilesFrame) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<FilesFrame> {
  let match: FilesFrame | undefined;
  const found = await pollUntil(
    () => {
      match = frames.find(predicate);
      return match !== undefined;
    },
    timeoutMs,
    50,
  );
  if (!found || !match) {
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${description}\n` +
        `--- frames seen ---\n${frames.map((f) => f.type).join('\n')}`,
    );
  }
  return match;
}
```

Check the exact `DataChannelMessage` / `onMessage` generics against `packages/webrtc-core/src/data-channel.ts` and adjust the generic parameter if it constrains `payload` more tightly than `Record<string, unknown>` (the terminal helpers use `TerminalDataMessage`; files frames are heterogeneous, so the loose record is deliberate — cast at the use site with the Task 1 payload type).

- [ ] **Step 2: Write the E2E suite**

Create `packages/webrtc-core/test/e2e/files.e2e.test.ts`:

```typescript
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PeerConnection } from '../../src/connection';
import { RESTPollingTransport } from '../../src/transport';
import {
  isLinux,
  BASE_URL,
  setupE2E,
  teardownE2E,
  seed,
  spawnAgent,
  waitForAgentOnline,
  openFilesPeer,
  waitForFilesFrame,
  agents,
  type FilesFrame,
} from './harness';
import type {
  FilesAckMessage,
  FilesDownloadBegin,
  FilesDownloadRequest,
  FilesErrorCode,
  FilesErrorMessage,
  FilesListRequest,
  FilesListResult,
  FilesUploadBeginRequest,
  FilesUploadComplete,
  FilesUploadEndRequest,
  FileChunkMessage,
} from '@ponter/shared';

const FILE_CHUNK_BYTES = 32768;
const WINDOW = 16;

/**
 * Layer 3: a real Rust agent serving a real directory over a real
 * DTLS/SCTP channel, driven by a raw TypeScript offerer (spec §8.3).
 * No Xvfb, no capture stack — mirror of terminal.e2e.test.ts.
 */
describe.skipIf(!isLinux)('cross-language files E2E', () => {
  let rootDir: string;
  let outsideDir: string;

  beforeAll(async () => {
    await setupE2E();
    rootDir = mkdtempSync(join(tmpdir(), 'ponter-files-root-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'ponter-files-outside-'));
    // Seed: a small file, a subdirectory with a file, and a 600 KiB file
    // (19 chunks — larger than the 16-chunk window, so the sender must pause
    // for acks; spec §8.3 "download").
    writeFileSync(join(rootDir, 'notes.txt'), 'hello ponter\n');
    mkdirSync(join(rootDir, 'docs'));
    writeFileSync(join(rootDir, 'docs', 'readme.md'), '# docs\n');
    const big = Buffer.alloc(600 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    writeFileSync(join(rootDir, 'big.bin'), big);
    // The escape target lives OUTSIDE the root; the path-escape test proves
    // the sandbox refuses to reach it.
    writeFileSync(join(outsideDir, 'secret.txt'), 'outside\n');
  }, 120_000);

  afterAll(async () => {
    await teardownE2E(() => {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    });
  }, 60_000);

  /** Register + spawn an agent whose files gate is open on `rootDir`. */
  async function connectFilesAgent(): Promise<{
    token: string;
    agentId: string;
    sessionId: string;
    frames: FilesFrame[];
    offerer: PeerConnection;
    send: (type: string, payload: unknown) => void;
  }> {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['files'],
    });
    spawnAgent(agentId, credential, ['--files-root', rootDir]);
    await waitForAgentOnline(token, agentId);
    const { offerer, frames } = await openFilesPeer(
      new RESTPollingTransport({ baseUrl: BASE_URL, sessionId, token }),
    );
    return {
      token,
      agentId,
      sessionId,
      frames,
      offerer,
      send: (type, payload) =>
        offerer.dataChannels.sendJson('files', type, payload),
    };
  }

  it('lists the seeded directory with sizes and types', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const request: FilesListRequest = {
        requestId: crypto.randomUUID(),
        path: '',
      };
      send('files-list', request);

      const frame = await waitForFilesFrame(
        frames,
        (f) => f.type === 'files-list-result',
        'files-list-result for the root',
      );
      const result = frame.payload as unknown as FilesListResult;
      expect(result.requestId).toBe(request.requestId);
      expect(result.truncated).toBe(false);

      const names = result.entries.map((e) => e.name).sort();
      expect(names).toEqual(['big.bin', 'docs', 'notes.txt']);

      const notes = result.entries.find((e) => e.name === 'notes.txt');
      expect(notes?.isDirectory).toBe(false);
      expect(notes?.size).toBe('hello ponter\n'.length);

      const docs = result.entries.find((e) => e.name === 'docs');
      expect(docs?.isDirectory).toBe(true);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('downloads a 600 KiB file byte-for-byte across the 16-chunk window', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const transferId = crypto.randomUUID();
      send('files-download', {
        transferId,
        path: 'big.bin',
      } satisfies FilesDownloadRequest);

      const begin = (await waitForFilesFrame(
        frames,
        (f) => f.type === 'files-download-begin',
        'files-download-begin',
      )).payload as unknown as FilesDownloadBegin;
      const totalChunks = Math.ceil((600 * 1024) / FILE_CHUNK_BYTES);
      expect(begin.size).toBe(600 * 1024);
      expect(begin.totalChunks).toBe(totalChunks);
      expect(totalChunks).toBeGreaterThan(WINDOW); // the window is exercised

      const chunks = new Map<number, Buffer>();
      let acked = 0;

      // Drive the sender: ack every chunk as it arrives. The agent pauses at
      // the 16-chunk window until acks arrive (ADR-34).
      const deadline = Date.now() + 60_000;
      while (acked < totalChunks && Date.now() < deadline) {
        const pending = frames.filter(
          (f) =>
            f.type === 'files-download-chunk' &&
            !chunks.has(
              ((f.payload as unknown as FileChunkMessage).chunkIndex ?? -1),
            ),
        );
        for (const frame of pending) {
          const chunk = frame.payload as unknown as FileChunkMessage;
          chunks.set(chunk.chunkIndex, Buffer.from(chunk.data, 'base64'));
          acked = chunks.size;
          send('files-download-ack', {
            transferId,
            nextChunkIndex: acked,
          } satisfies FilesAckMessage);
        }
        if (acked < totalChunks) await delay(50);
      }

      expect(acked).toBe(totalChunks);
      await waitForFilesFrame(
        frames,
        (f) => f.type === 'files-download-end',
        'files-download-end',
      );

      const assembled = Buffer.concat(
        [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b),
      );
      expect(Buffer.compare(assembled, readFileSync(join(rootDir, 'big.bin')))).toBe(0);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('uploads a 100 KiB file that lands byte-equal with no .part left behind', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const transferId = crypto.randomUUID();
      const payload = Buffer.alloc(100 * 1024);
      for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7) % 256;
      const totalChunks = Math.ceil(payload.length / FILE_CHUNK_BYTES); // 4

      send('files-upload-begin', {
        transferId,
        path: '',
        name: 'uploaded.bin',
        size: payload.length,
      } satisfies FilesUploadBeginRequest);

      // Wait for the first ack before sending, then keep the window open.
      await waitForFilesFrame(
        frames,
        (f) =>
          f.type === 'files-upload-ack' &&
          (f.payload as unknown as FilesAckMessage).transferId === transferId &&
          (f.payload as unknown as FilesAckMessage).nextChunkIndex === 0,
        'files-upload-ack { nextChunkIndex: 0 }',
      );

      for (let index = 0; index < totalChunks; index += 1) {
        const slice = payload.subarray(
          index * FILE_CHUNK_BYTES,
          Math.min((index + 1) * FILE_CHUNK_BYTES, payload.length),
        );
        send('files-upload-chunk', {
          transferId,
          chunkIndex: index,
          totalChunks,
          data: slice.toString('base64'),
        } satisfies FileChunkMessage);

        // The ack for chunk `index` is `nextChunkIndex: index + 1`.
        await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-upload-ack' &&
            (f.payload as unknown as FilesAckMessage).transferId === transferId &&
            (f.payload as unknown as FilesAckMessage).nextChunkIndex === index + 1,
          `files-upload-ack { nextChunkIndex: ${index + 1} }`,
        );
      }

      send('files-upload-end', { transferId } satisfies FilesUploadEndRequest);

      const complete = (await waitForFilesFrame(
        frames,
        (f) => f.type === 'files-upload-complete',
        'files-upload-complete',
      )).payload as unknown as FilesUploadComplete;
      expect(complete.name).toBe('uploaded.bin');
      expect(complete.size).toBe(payload.length);

      expect(Buffer.compare(readFileSync(join(rootDir, 'uploaded.bin')), payload)).toBe(0);
      expect(existsSync(join(rootDir, 'uploaded.bin.ponter-part'))).toBe(false);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('cancel mid-download stops the chunks, logs, and leaves the session usable', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const transferId = crypto.randomUUID();
      send('files-download', {
        transferId,
        path: 'big.bin',
      } satisfies FilesDownloadRequest);

      // Ack exactly one chunk, then cancel. The sender's window is open (16),
      // so further chunks are only suppressed by the cancel handling.
      await waitForFilesFrame(
        frames,
        (f) => f.type === 'files-download-chunk',
        'the first download chunk',
      );
      send('files-download-ack', {
        transferId,
        nextChunkIndex: 1,
      } satisfies FilesAckMessage);
      send('files-cancel', { transferId });

      // Bounded window: after acking exactly ONE chunk and cancelling, no
      // chunk with index >= 1 may ever arrive — the window had 15 free slots,
      // so only the cancel handling can suppress them.
      await delay(1_000);
      const late = frames.filter(
        (f) =>
          f.type === 'files-download-chunk' &&
          (f.payload as unknown as FileChunkMessage).transferId === transferId &&
          (f.payload as unknown as FileChunkMessage).chunkIndex >= 1,
      );
      expect(late).toHaveLength(0);

      // The agent logged the cancel at info level (spec §6.1).
      const agentLog = agents.map((a) => a.output()).join('\n');
      expect(agentLog).toContain('files transfer cancelled');

      // Fail-soft: the session still serves a fresh list (spec §2.6).
      const requestId = crypto.randomUUID();
      send('files-list', { requestId, path: '' } satisfies FilesListRequest);
      const result = (await waitForFilesFrame(
        frames,
        (f) =>
          f.type === 'files-list-result' &&
          (f.payload as unknown as FilesListResult).requestId === requestId,
        'a files-list-result after the cancel',
      )).payload as unknown as FilesListResult;
      expect(result.entries.length).toBeGreaterThan(0);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('refuses paths outside the root with PATH_OUTSIDE_ROOT', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const cases = [
        { path: '../outside/secret.txt', label: 'a .. escape' },
        { path: '..', label: 'a bare ..' },
        { path: '/etc/passwd', label: 'an absolute path' },
      ];
      for (const { path, label } of cases) {
        const transferId = crypto.randomUUID();
        send('files-download', {
          transferId,
          path,
        } satisfies FilesDownloadRequest);
        const error = (await waitForFilesFrame(
          frames,
          (f) =>
            f.type === 'files-error' &&
            (f.payload as unknown as FilesErrorMessage).transferId === transferId,
          `files-error for ${label}`,
        )).payload as unknown as FilesErrorMessage;
        // The refusal is the contract this E2E pins: an escape attempt must
        // produce a files-error and no bytes. Which code depends on the
        // spec's two readings — ADR-33 lists `..` among syntactically
        // rejected components (INVALID_PATH), while §6.4's contract table
        // resolves `a/../../etc/passwd` through canonicalize to
        // PATH_OUTSIDE_ROOT and pins absolute paths to INVALID_PATH. The
        // exact mapping is pinned by the Rust unit tests (Task 4); here both
        // refusal codes are accepted so the suite does not encode one
        // reading of that tension.
        expect(['PATH_OUTSIDE_ROOT', 'INVALID_PATH']).toContain(
          error.code as FilesErrorCode,
        );
      }
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('refuses the offer when the gate is closed', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['files'],
    });
    // No --files-root: the gate is closed (ADR-32).
    spawnAgent(agentId, credential);
    await waitForAgentOnline(token, agentId);

    let refused = false;
    try {
      await openFilesPeer(
        new RESTPollingTransport({ baseUrl: BASE_URL, sessionId, token }),
      );
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);

    const agentLog = agents.map((a) => a.output()).join('\n');
    expect(agentLog).toContain('refused: files root not configured or unusable');
  }, 90_000);

  it('refuses an upload onto an existing name with FILE_EXISTS and leaves it untouched', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const before = readFileSync(join(rootDir, 'notes.txt'));
      const transferId = crypto.randomUUID();
      send('files-upload-begin', {
        transferId,
        path: '',
        name: 'notes.txt',
        size: 4,
      } satisfies FilesUploadBeginRequest);

      const error = (await waitForFilesFrame(
        frames,
        (f) =>
          f.type === 'files-error' &&
          (f.payload as unknown as FilesErrorMessage).transferId === transferId,
        'files-error for the overwrite attempt',
      )).payload as unknown as FilesErrorMessage;
      expect(error.code).toBe('FILE_EXISTS');

      expect(Buffer.compare(readFileSync(join(rootDir, 'notes.txt')), before)).toBe(0);
      expect(existsSync(join(rootDir, 'notes.txt.ponter-part'))).toBe(false);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  it('refuses a declared-oversize upload before any chunk with FILE_TOO_LARGE', async () => {
    const { offerer, frames, send } = await connectFilesAgent();
    try {
      const transferId = crypto.randomUUID();
      send('files-upload-begin', {
        transferId,
        path: '',
        name: 'huge.bin',
        size: 2 ** 30 + 1,
      } satisfies FilesUploadBeginRequest);

      const error = (await waitForFilesFrame(
        frames,
        (f) =>
          f.type === 'files-error' &&
          (f.payload as unknown as FilesErrorMessage).transferId === transferId,
        'files-error for the oversize upload',
      )).payload as unknown as FilesErrorMessage;
      expect(error.code).toBe('FILE_TOO_LARGE');
      expect(existsSync(join(rootDir, 'huge.bin.ponter-part'))).toBe(false);
      expect(existsSync(join(rootDir, 'huge.bin'))).toBe(false);
    } finally {
      await offerer.close();
    }
  }, 90_000);
});
```

- [ ] **Step 3: Build the agent binary, then run the suite and watch it fail (or skip) for the right reason**

Run (from the repo root):

```bash
cargo build --manifest-path apps/agent/Cargo.toml
pnpm --filter @ponter/webrtc-core test:e2e -- files.e2e
```

Expected: with Tasks 4-7 merged, all eight tests PASS. If Tasks 4-7 are not yet implemented, the first test fails on `files-list-result` never arriving (or the agent exits at startup on the unknown `--files-root` flag) — that is the correct red for a test-first run.

- [ ] **Step 4: Verify the window boundary is actually exercised**

Run: `RUST_LOG=debug pnpm --filter @ponter/webrtc-core test:e2e -- files.e2e`
Expected: the download test passes and the agent log shows the sender pausing (chunks stop arriving between the 16th chunk and the first ack). This step is a manual sanity check of the window claim in spec §8.3 — no assertion is added for the pause itself (timing-based assertions are flaky; the 19-chunk file size is the structural pin).

- [ ] **Step 5: Run the full local CI mirror (spec §10.2 AC2 + AC4)**

Run (from the repo root; the harness spawns the debug binary built in Step 3):

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm format:check
pnpm --filter @ponter/webrtc-core test:e2e
cargo check --manifest-path apps/agent/Cargo.toml --locked --target x86_64-unknown-linux-musl
```

Expected: all PASS. This is the local mirror of every CI gate before the branch PR:

- `pnpm lint && pnpm typecheck && pnpm test` is **AC2 verbatim** — turbo also runs `@ponter/agent`'s `cargo fmt --check && cargo clippy --all-targets -- -D warnings` (a superset of `CI (Node)`, which splits the Rust crate out), plus `@ponter/file-core`, web, and shared.
- `pnpm format:check` is `CI (Node)`'s formatting step. If it flags the new files, run `pnpm format` and include the reformat in this task's commit.
- `pnpm --filter @ponter/webrtc-core test:e2e` (no `-- files.e2e` filter) runs **every** suite — desktop, shutdown, terminal, terminal-ws, and files — which is **AC4**: the existing suites still pass unchanged. `CI (E2E)` runs exactly this command.
- The musl `cargo check` is **AC1**'s second half (`Build Agent / Linux/x64-musl`); skip it only if the target is not installed locally (CI covers it).

If anything is red, fix it here (or rule it back to the owning task) before committing — the branch must be green end-to-end.

- [ ] **Step 6: Commit**

```bash
git add packages/webrtc-core/test/e2e/harness.ts packages/webrtc-core/test/e2e/files.e2e.test.ts
git commit -m "test(e2e): cross-language files suite with list, download, upload, cancel, gate and sandbox cases"
```

---
### Task 11: Docs reconciliation + recorded demo (D6, D7)

**Files:**
- Modify: `docs/ARCHITECTURE.md` (Phase 4 roadmap entry `:1003-1005`; perf-table row `:1147`; security status note)
- Modify: `docs/guides/agent-setup.md` (§3 CLI options `:45-60`; §4.3 env vars `:101-109`)
- Create: `docs/superpowers/specs/2026-10-04-phase4-week10-demo.md`

**Interfaces:**
- Consumes: the spec's §11 reconciliation list (five items), §8.4 demo steps, §9.2 security status, §10.2's explicit non-AC list; the Week 9 demo doc's structure (`docs/superpowers/specs/2026-10-03-phase3-week9-demo.md`) as the format precedent.
- Produces: D7 (docs) and D6 (demo artifact). The demo doc is **recorded evidence** — it must be honest about what was and was not run; the Week 9 doc's "Not observed" precedent is the model.

> **Honesty rules for this task (spec §1.2, §3.7, §9.2, §10.2 — Review Focus #6):**
> 1. The demo doc may **not** claim a throughput number as a property of the system — the >10MB/s row is Week 11 scope, not measured, not an AC. A stopwatch observation may be recorded, explicitly labeled informal.
> 2. No row may claim E2EE or peer identity. Files cross the wire under DTLS only (H11/M7/M8); the gate is a policy holding pattern closed by WS1/WS2/WS3 (H2/H3).
> 3. Windows/macOS runtime filesystem behavior is **unverified** (§3.7) — compile + unit tests only.
> 4. Week 11 is **not started**; the Phase 4 roadmap item stays unchecked.
> 5. Historical note: `ARCHITECTURE.md` and `agent-setup.md` previously used Vietnamese conventions, but all repository documentation has been standardized to English. The demo doc follows the Week 9 doc's English convention.

- [ ] **Step 1: `docs/ARCHITECTURE.md` — replace the Phase 4 stub**

Replace `:1003-1005` (the heading plus the "Not yet designed" blockquote):

```markdown
### Phase 4: File Transfer (Weeks 10-11)

> **Status:** Week 10 is a completed *thin slice* — third session mode `Files` on a single data channel `files`, bidirectional upload/download, single-root sandbox, refusal gate at offer. Week 11 (large files, streaming, performance) **not yet started**.

#### Week 10: File Transfer — thin slice (completed)

- [x] Third session mode `Files` with channel label `files` — `classify_offer` order terminal → desktop → files (ADR-31)
- [x] Refusal gate at offer: missing `--files-root` (or unusable root) ⇒ answer `approved: false`, close peer, do not open session — DEFAULT OFF, enabled only via local flag (ADR-32)
- [x] Single-root sandbox with canonicalize + prefix check; POSIX-relative wire path; upload via `{name}.ponter-part` + atomic rename, refuse overwrite `FILE_EXISTS` (ADR-33)
- [x] Chunk protocol 32 KiB + base64 under 64 KiB frame ceiling; 16-chunk sliding window with cumulative ack; 30 s timeout; one transfer per direction (ADR-34)
- [x] Web — `files` tab (FilesView: breadcrumb, file list, click to download, upload to current folder, progress + cancel, error banner), agent-exclusive across all three modes (ADR-14)
- [x] Cross-language E2E (`files.e2e.test.ts`) — list, byte-equal download, byte-equal upload, cancel mid-flight, path escape, closed gate, overwrite, oversized upload declaration
- [x] Server **unchanged** — no columns, no endpoints, no migrations (ADR-35)

> Week 11 (large files, disk streaming, performance) **not yet started** — Phase 4 item is not marked complete.

> **Files gate is a temporary policy holding pattern, not a security patch.** Peer is not yet authenticated (H3); `approved` is not yet enforced (H2); file traffic is protected by DTLS only (H11/M7/M8). The gate prevents the *consequence* (file access on unverified peer) by default, but the findings remain — closed by **WS1/WS2/WS3** (Phase 5). See `docs/security/2026-10-01-e2ee-zero-trust-audit.md` and spec `docs/superpowers/specs/2026-10-04-phase4-week10-file-transfer-design.md`.
```

- [ ] **Step 2: `docs/ARCHITECTURE.md` — annotate the perf row**

Replace `:1147`:

```markdown
| File Transfer | > 10MB/s | Parallel chunks — **Week 11 scope, NOT YET measured** (Week 10 runs single-stream sequential only; stopwatch measurements in demo are informal observations, not acceptance criteria) |
```

- [ ] **Step 3: `docs/guides/agent-setup.md` — CLI options**

In §3 (`:45-60`), inside the options block, after the `--rows` line add:

```
      --files-root <FILES_ROOT>  Directory served for files sessions. NO default:
                                 empty = files gate closed (offer refused) [env: AGENT_FILES_ROOT]
```

And after the code block (before the `---` at `:62`), add the one-line security note:

```markdown
> **Security:** `--files-root` grants read/write permissions within that directory for authenticated sessions, but the **peer identity is not yet verified** (H3 — Phase 5). Only point to directories you intentionally share; there is no default, gate remains closed when flag is absent.
```

- [ ] **Step 4: `docs/guides/agent-setup.md` — env vars**

In §4.3 (`:103-109`), add to the `.env` block after `STUN`:

```env
# Optional: open files gate. Empty = gate closed (safe default).
# AGENT_FILES_ROOT=/srv/ponter-files
```

- [ ] **Step 5: Create the demo doc**

Create `docs/superpowers/specs/2026-10-04-phase4-week10-demo.md`:

```markdown
# Phase 4 Week 10 — File Transfer Demo

**Date:** 2026-10-04
**Machine:** Fedora Linux, X11 session
**Agent:** `ponter-agent --files-root /tmp/ponter-demo-files` (build <commit sha at demo time>)

## Status

**Recorded** (manual pass on the Fedora dev machine, per spec §8.4) / **Not observed** for rows marked ⚠️ — see Notes. Fill each row with what actually happened; do not mark a row ✅ without having run it.

## Checklist (spec §8.4)

| # | Check | Result |
|---|---|---|
| 1 | Gate open: root listing shows the seeded files and subdirectory | ⬜ |
| 2 | Enter subdirectory, breadcrumb back to root | ⬜ |
| 3 | Download a small file; hash matches the on-disk original | ⬜ |
| 4 | Download the > 100 MiB file; progress advances; stopwatch observation recorded (informal, not gated) | ⬜ |
| 5 | Upload a file from the desktop; bytes land on disk; no `.ponter-part` remains | ⬜ |
| 6 | Cancel a mid-flight download; transfer line disappears; a later listing still works | ⬜ |
| 7 | Attempt an overwrite; `FILE_EXISTS` banner appears ("A file with that name already exists"); original bytes unchanged | ⬜ |
| 8 | Gate closed (`--files-root` omitted): files tab shows the refusal message; no session opens | ⬜ |

## Observed

Record the run's actual observations here, including:

- the informal throughput observation for check 4 (stopwatch, file size, elapsed time, rough MB/s) — **labeled informal, not an acceptance criterion** (spec §10.2);
- the exact refusal text seen in check 8 (expected: "The agent refused this session. It may be busy (one session per agent) or file access may not be configured on the agent.");
- anything that behaved differently from the spec.

## Real-screen evidence

Screenshots / recording reference for checks 1, 4, 6, 7, 8 (a files tab listing, a transfer in progress, the cancel, the `FILE_EXISTS` banner, the gate-closed refusal).

## Notes

- **Throughput is not a claim.** The > 10MB/s target (`ARCHITECTURE.md:1147`) is Week 11 scope; Week 10 runs a single sequential stream. Any number here is an informal stopwatch observation only.
- **No E2EE.** File bytes and names cross the wire under DTLS only (H11/M7/M8). Application-layer encryption is WS1 (Phase 5).
- **No peer identity.** The agent does not verify the client (H3); `approved` is not enforced (H2). The gate (ADR-32) is a policy holding pattern closed by WS1/WS2/WS3.
- **Windows/macOS runtime unverified.** The path sandbox is compile + unit-tested on those targets only (spec §3.7).
- **Week 11 not started.** Large files, streaming to disk, and performance work are out of scope.

## Scope notes

- **Browser memory:** the thin slice holds a whole file in memory (client buffer + Blob on download; `File.arrayBuffer()` on upload) — accepted for the demo, revisited in Week 11 (spec §9.4).
- **One transfer per direction:** a second download while one runs is refused with `TRANSFER_BUSY`; a concurrent upload is allowed.
- **No overwrite:** uploads onto an existing name are refused (`FILE_EXISTS`) — by design in the thin slice (ADR-33), not a bug.
```

- [ ] **Step 6: Verify no claim outruns the evidence**

Re-read the two edited ARCHITECTURE blocks and the demo doc against the honesty rules in the task header:
- no throughput claim outside the "informal, not measured" annotation;
- no E2EE/identity claim;
- Week 11 marked not started; Phase 4 item not ticked done;
- the gate described as a holding pattern closed by WS1/WS2/WS3.

- [ ] **Step 7: Confirm every acceptance criterion (spec §10.2)**

Walk spec §10.2 and tick each against evidence. No row claims more than the thin slice delivers (Review Focus #6):

| # | Criterion (spec §10.2) | Evidence |
|---|---|---|
| 1 | `cargo test --locked` passes with the new unit tests; the musl target still builds (`files.rs` not gated, no new dependency) | Tasks 4-7 unit runs + Task 10, Step 5 (workspace sweep + musl `cargo check`) + `Build Agent / Verify` + `Build Agent / Linux/x64-musl` |
| 2 | `pnpm lint && pnpm typecheck && pnpm test` pass workspace-wide, including `@ponter/file-core` and the updated web dialog tests | Task 10, Step 5 (AC2 verbatim) + `CI (Node)` |
| 3 | E2E `files.e2e.test.ts`: list, download byte-equal, upload byte-equal (`.part` gone), cancel mid-download (session unharmed), path escape → `PATH_OUTSIDE_ROOT`, gate off → `approved: false` + refusal warn in the agent log, overwrite → `FILE_EXISTS`, declared-oversize → `FILE_TOO_LARGE` | Task 10, Steps 3-4 + `CI (E2E)` |
| 4 | Existing terminal and desktop E2E suites pass unchanged; `webrtc-core` source unchanged | Task 10, Step 5 (full `test:e2e` — every suite) + `CI (E2E)`; `git diff main --stat -- packages/webrtc-core/src` shows nothing |
| 5 | Three-way exclusivity in unit tests: a files tab is refused when any tab is open; `openTab`/`openDesktopTab` are refused when a files tab exists | Task 8 (`files-store.test.ts`: `openFilesTab refuses when the agent already has any open tab`, `openTab refuses when a files tab exists`, `openDesktopTab refuses when a files tab exists`) |
| 6 | `ARCHITECTURE.md` records the Week 10 scope and the gate; `agent-setup.md` documents `--files-root` / `AGENT_FILES_ROOT` | This task, Steps 1-4 |
| 7 | The recorded demo shows both directions with the gate open and the refusal with the gate closed | This task, Step 5 — the demo doc is the artifact; its rows say only what was actually run (unrun rows stay ⬜, per the honesty rules above) |

**Explicitly NOT acceptance criteria** (spec §10.2): the >10MB/s throughput target (Week 11 scope); E2EE/peer identity/consent (WS1/WS2/WS3, Phase 5); resumable or parallel transfers, streaming large files in the browser; Windows/macOS runtime filesystem behavior; the server listing or authorizing sessions by mode.

- [ ] **Step 8: Commit**

```bash
git add docs/ARCHITECTURE.md docs/guides/agent-setup.md docs/superpowers/specs/2026-10-04-phase4-week10-demo.md
git commit -m "docs: record Week 10 file transfer scope, --files-root setup and demo"
```

---

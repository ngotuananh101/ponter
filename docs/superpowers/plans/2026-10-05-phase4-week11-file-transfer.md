# Phase 4 Week 11 — File Transfer Hardening, Streaming, Queue, Pause/Resume & High Throughput Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 4 File Transfer by adding hybrid binary multiplexing (>10 MB/s throughput), Service Worker disk streaming, chunk-sliced uploads, transfer queue with drag & drop, pause & resume with 24-hour part file TTL, and sandboxed file operations (`mkdir`, `delete`, `rename`).

**Architecture:** Multiplex JSON control envelopes and raw binary chunks on the `'files'` data channel. Deliver streaming downloads through a Service Worker interceptor writing directly to disk, stream uploads via `File.slice()` chunks, coordinate transfers with a Pinia transfer queue (1 upload + 1 download concurrent), support pause/resume with byte-aligned part files, and enforce strict sandbox containment for directory management.

**Tech Stack:** Rust (Tokio, async-fs, UUID), TypeScript, Vue 3, Pinia, WebRTC DataChannels, Service Worker API (`ReadableStream`, `MessageChannel`).

**Spec:** `docs/superpowers/specs/2026-10-05-phase4-week11-file-transfer-design.md`

## Global Constraints

- **Exact Wire Compatibility:** Channel label must remain `'files'` (`main.rs`, `rtc.rs`).
- **Binary Header Layout:** Exactly 25 bytes: `[Type: 1B] [TransferId: 16B] [ChunkIndex: 8B BE] [Payload: N <= 32768B]` (ADR-36).
- **Throughput Windows:** Sliding window capacity of 64 chunks (~2 MiB in-flight). Cumulative acks flushed every 16 chunks or 20 ms timer (ADR-37).
- **Service Worker Route:** Worker hosted at `/sw-files-download.js`, intercepting `/files-download-stream/:transferId/:filename` (ADR-38).
- **TTL Janitor:** Stale `.ponter-part` files older than 24 hours (86,400 s) deleted automatically; fresh files preserved (ADR-39).
- **Sandbox Root Immutability:** Deleting or renaming the root directory (`path == ""`) is strictly forbidden and must return `PERMISSION_DENIED` (ADR-40).
- **Non-Overwrite Rule:** Uploads and renames must never overwrite existing files; return `FILE_EXISTS` (ADR-33, ADR-40).
- **Commit Discipline:** Path-limited commits only (`git commit -m "..." -- <paths>`). No bare `git add .`.

## Review Focus

1. **Binary Frame Truncation / Malformed Header:** An incoming binary frame with length < 25 bytes or > 32793 bytes (25 header + 32768 payload) must be safely rejected without panicking the agent or breaking the client loop.
2. **Resume Chunk Alignment Mismatch:** Resuming an upload with `fromChunkIndex` where existing `.part` size does not equal `fromChunkIndex * 32768` must return `RESUME_INVALID` and refuse to append corrupted data.
3. **Sandbox Directory Traversal in Rename:** Renaming with `newPath` containing `../` or resolving outside the sandbox root must be rejected with `PATH_OUTSIDE_ROOT`.
4. **Service Worker MessageChannel Drop:** If the user closes the download tab while Service Worker is streaming, the stream controller must close or error gracefully without leaving dangling worker channels.
5. **Simultaneous Drag & Drop Batch Exhaustion:** Dropping 20+ files at once must safely enqueue all items into `transferQueue` while maintaining strictly 1 active upload at a time.

---

### Task 1: Shared Types & Wire Protocol Envelopes (`packages/shared`)

**Files:**
- Modify: `packages/shared/src/types/files.ts`
- Test: `packages/shared/test/files-types.test.ts`

**Interfaces:**
- Produces:
  - Binary layout constants: `BINARY_TYPE_DOWNLOAD_CHUNK = 0x01`, `BINARY_TYPE_UPLOAD_CHUNK = 0x02`, `BINARY_HEADER_LEN = 25`.
  - Pause/Resume interfaces: `FilesPauseMessage`, `FilesPauseAckMessage`, `FilesResumeRequest`, `FilesResumeAckMessage`.
  - Directory operations: `FilesMkdirRequest`, `FilesDeleteRequest`, `FilesRenameRequest`, `FilesActionResult`.
  - Error codes: `FilesErrorCode` extended with `'RESUME_INVALID'`, `'DIR_NOT_EMPTY'`, `'PERMISSION_DENIED'`, `'QUEUE_FULL'`.
  - Queue types: `QueueItem`, `QueueStatus`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/test/files-types.test.ts
import { describe, it, expect } from 'vitest';
import {
  BINARY_TYPE_DOWNLOAD_CHUNK,
  BINARY_TYPE_UPLOAD_CHUNK,
  BINARY_HEADER_LEN,
  type FilesPauseMessage,
  type FilesResumeRequest,
  type FilesMkdirRequest,
  type FilesErrorCode,
} from '../src/types/files';

describe('Week 11 Shared File Transfer Types', () => {
  it('exports binary frame constants', () => {
    expect(BINARY_TYPE_DOWNLOAD_CHUNK).toBe(0x01);
    expect(BINARY_TYPE_UPLOAD_CHUNK).toBe(0x02);
    expect(BINARY_HEADER_LEN).toBe(25);
  });

  it('validates pause and resume types structure', () => {
    const pause: FilesPauseMessage = { transferId: 't-1', direction: 'upload' };
    const resume: FilesResumeRequest = {
      transferId: 't-1',
      path: 'docs/file.bin',
      direction: 'upload',
      fromChunkIndex: 10,
    };
    expect(pause.transferId).toBe('t-1');
    expect(resume.fromChunkIndex).toBe(10);
  });

  it('validates mkdir request type structure', () => {
    const mkdir: FilesMkdirRequest = {
      requestId: 'r-1',
      dir: 'sub',
      name: 'nested',
    };
    expect(mkdir.name).toBe('nested');
  });

  it('includes new error codes in FilesErrorCode union', () => {
    const errors: FilesErrorCode[] = [
      'RESUME_INVALID',
      'DIR_NOT_EMPTY',
      'PERMISSION_DENIED',
      'QUEUE_FULL',
    ];
    expect(errors).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/shared test`  
Expected: FAIL with missing exports in `files.ts`.

- [ ] **Step 3: Write implementation in `packages/shared/src/types/files.ts`**

Add the constants, interfaces, and extended union as specified in ADR-36 and ADR-40.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/shared test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(shared): add Week 11 file transfer wire types and binary constants" -- packages/shared/src/types/files.ts packages/shared/test/files-types.test.ts
```

---

### Task 2: Agent Binary Frame Parser & Basic File Operations (`apps/agent`)

**Files:**
- Modify: `apps/agent/src/files.rs`
- Test: `apps/agent/src/files.rs` (unit test module)

**Interfaces:**
- Consumes: Wire contracts from Spec §3.2 & §3.3.
- Produces:
  - `pub fn decode_files_binary_frame(bytes: &[u8]) -> FilesResult<BinaryChunkFrame>`
  - `pub fn encode_files_binary_frame(frame_type: u8, transfer_id: &[u8; 16], chunk_index: u64, payload: &[u8]) -> Vec<u8>`
  - Sandbox directory operations: `handle_mkdir`, `handle_delete`, `handle_rename` on `FilesRoot`.

- [ ] **Step 1: Write failing Rust unit tests in `apps/agent/src/files.rs`**

```rust
#[cfg(test)]
mod tests_week11 {
    use super::*;

    #[test]
    fn test_binary_frame_roundtrip() {
        let transfer_id = [7u8; 16];
        let chunk_index = 42u64;
        let payload = b"hello binary world";
        let encoded = encode_files_binary_frame(BINARY_TYPE_DOWNLOAD_CHUNK, &transfer_id, chunk_index, payload);
        assert_eq!(encoded.len(), BINARY_HEADER_LEN + payload.len());

        let decoded = decode_files_binary_frame(&encoded).expect("decode should succeed");
        assert_eq!(decoded.frame_type, BINARY_TYPE_DOWNLOAD_CHUNK);
        assert_eq!(decoded.transfer_id, transfer_id);
        assert_eq!(decoded.chunk_index, chunk_index);
        assert_eq!(decoded.data, payload);
    }

    #[test]
    fn test_binary_frame_truncated_header() {
        let short_bytes = vec![0x01; 24]; // 1 byte short of 25-byte header
        let err = decode_files_binary_frame(&short_bytes).unwrap_err();
        assert_eq!(err.code(), FilesErrorCode::BadFrame);
    }

    #[tokio::test]
    async fn test_mkdir_delete_rename_sandbox() {
        let temp = tempfile::tempdir().unwrap();
        let root = FilesRoot::new(temp.path()).await.unwrap();

        // 1. mkdir
        root.mkdir("", "test_dir").await.unwrap();
        let created = temp.path().join("test_dir");
        assert!(created.is_dir());

        // 2. rename
        tokio::fs::write(created.join("sample.txt"), b"data").await.unwrap();
        root.rename("test_dir/sample.txt", "test_dir/renamed.txt").await.unwrap();
        assert!(created.join("renamed.txt").exists());
        assert!(!created.join("sample.txt").exists());

        // 3. delete root rejected
        let del_err = root.delete("", false).await.unwrap_err();
        assert_eq!(del_err.code(), FilesErrorCode::PermissionDenied);

        // 4. delete non-empty directory without recursive rejected
        let del_dir_err = root.delete("test_dir", false).await.unwrap_err();
        assert_eq!(del_dir_err.code(), FilesErrorCode::DirNotEmpty);

        // 5. delete directory with recursive
        root.delete("test_dir", true).await.unwrap();
        assert!(!created.exists());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/agent/Cargo.toml files::tests_week11`  
Expected: FAIL with functions not found.

- [ ] **Step 3: Implement binary encode/decode and directory handlers in `apps/agent/src/files.rs`**

- Implement `decode_files_binary_frame` checking `bytes.len() >= 25` and `bytes.len() <= 25 + 32768`.
- Implement `encode_files_binary_frame` allocating `25 + payload.len()` vector.
- Implement `FilesRoot::mkdir`, `FilesRoot::delete`, and `FilesRoot::rename` with containment and collision checks.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/agent/Cargo.toml files::tests_week11`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(agent): implement binary frame codec and sandboxed directory operations" -- apps/agent/src/files.rs
```

---

### Task 3: Agent Throughput Optimization, Pause/Resume & 24h Janitor (`apps/agent`)

**Files:**
- Modify: `apps/agent/src/files.rs`
- Modify: `apps/agent/src/main.rs` (binary transport wiring — see Interfaces)
- Modify: `apps/agent/Cargo.toml` (make `bytes` available on all targets)
- Test: `apps/agent/src/files.rs`

**Interfaces:**
- Produces:
  - Updated window capacity: `FILE_WINDOW_CHUNKS = 64`.
  - Pause handler: flushes file, leaves `.part` on disk, returns `FilesPauseAckMessage`.
  - Resume handler: validates `.part` size against `fromChunkIndex * 32768`, resumes streaming.
  - Janitor function: `clean_stale_part_files(root: &Path, max_age: Duration) -> u32`.
  - Binary transport (GAP-A ruling — no other task owns this): the agent files session carries both text and binary frames end-to-end:
    - Inbound: the poll task routes `DataChannelEvent::OnMessage` by `msg.is_string` — text frames keep the existing UTF-8 path; binary frames are forwarded as raw bytes to the session dispatch, where type `0x02` (`BINARY_TYPE_UPLOAD_CHUNK`) frames feed `handle_upload_chunk` via `decode_files_binary_frame`.
    - Outbound: `pump_download` emits binary frames via `encode_files_binary_frame(BINARY_TYPE_DOWNLOAD_CHUNK, …)` instead of base64 JSON `Outbound::DownloadChunk`; the pump sends them with `dc.send(BytesMut)` and keeps `send_text` for JSON frames.
    - The session's frame channel carries an enum of text-or-binary payloads (e.g. `FilesFrame::Text(String) | FilesFrame::Binary(Vec<u8>)`).
    - `bytes` must resolve on all targets (files sessions are NOT musl-gated): move/add `bytes = "1"` to the general `[dependencies]` in `apps/agent/Cargo.toml` (it currently sits under the non-musl target table).
  - Ack batching (ADR-37): `ACK_FREQUENCY_CHUNKS: u64 = 16`, `ACK_FLUSH_INTERVAL: Duration = 20ms` — upload acks are cumulative (highest contiguous chunk index) and flush every 16 chunks or every 20 ms, whichever first.
  - **Transfer-id codec (GAP-H ruling — the agent's binary codec does not match the client's):** `transfer_id_to_16` must strip dashes before the 32-hex decode (keep the raw-byte fallback for tests' short ids); `hex_encode_id` must re-insert the RFC 4122 dashes (8-4-4-4-12) so the decoded id equals the client's `crypto.randomUUID()` form. Spec §3.2 pins the wire as a raw 16-byte UUID; the client (Task 4) is correct. Add a regression test round-tripping a real dashed UUID.
  - **Resume ack (GAP-G ruling — no producer of `files-resume-ack` exists):** add `FilesResumeAckMessage` (camelCase, `reason` skip-if-none), `Outbound::ResumeAck` → `"files-resume-ack"`. `handle_resume` success → `approved: true` + `from_chunk_index`; `.part` mismatch / wrong direction / not paused → `approved: false` + `reason` (not a raw error frame); truly-unknown id → keep `transfer_unknown`. Pause stays `files-pause-ack`.
  - **Download pause/resume (GAP-J ruling — spec ADR-39 line 90 + AC#4 require it):** add `paused` to `DownloadState`. On download pause: keep the slot + state, emit `files-pause-ack` with `acked_chunk_index = state.acked`. On download resume: `seek(SeekFrom::Start(from_chunk_index * FILE_CHUNK_BYTES))`, set `sent = acked = from_chunk_index`, clear paused, emit `files-resume-ack { approved: true, from_chunk_index }`, then `pump_download`. `check_idle` must not reap a paused transfer (skip the deadline check while `paused`). Resume point is validated against `state.acked` (downloads have no `.part`). Add a unit test for download pause→resume offset continuity.

- [ ] **Step 1: Write failing Rust unit tests for pause/resume and janitor in `apps/agent/src/files.rs`**

```rust
#[cfg(test)]
mod tests_throughput_resume {
    use super::*;
    use std::time::{Duration, SystemTime};

    #[tokio::test]
    async fn test_pause_and_resume_alignment_check() {
        let temp = tempfile::tempdir().unwrap();
        let root = FilesRoot::new(temp.path()).await.unwrap();

        // Create a fake .part file of 65536 bytes (2 chunks of 32 KiB)
        let part_path = temp.path().join("upload.bin.ponter-part");
        tokio::fs::write(&part_path, vec![0u8; 65536]).await.unwrap();

        // Resume from chunk 2 should succeed (2 * 32768 = 65536)
        let ok = root.verify_resume_upload("upload.bin", 2).await;
        assert!(ok.is_ok());

        // Resume from chunk 3 should fail with RESUME_INVALID (3 * 32768 != 65536)
        let err = root.verify_resume_upload("upload.bin", 3).await.unwrap_err();
        assert_eq!(err.code(), FilesErrorCode::ResumeInvalid);
    }

    #[tokio::test]
    async fn test_janitor_cleans_stale_part_files() {
        let temp = tempfile::tempdir().unwrap();
        let stale_part = temp.path().join("stale.bin.ponter-part");
        let fresh_part = temp.path().join("fresh.bin.ponter-part");

        tokio::fs::write(&stale_part, b"stale").await.unwrap();
        tokio::fs::write(&fresh_part, b"fresh").await.unwrap();

        // Set mtime of stale_part to 25 hours ago
        let twenty_five_hours_ago = SystemTime::now() - Duration::from_secs(25 * 3600);
        filetime::set_file_mtime(&stale_part, filetime::FileTime::from_system_time(twenty_five_hours_ago)).unwrap();

        let removed = clean_stale_part_files(temp.path(), Duration::from_secs(24 * 3600)).await;
        assert_eq!(removed, 1);
        assert!(!stale_part.exists());
        assert!(fresh_part.exists());
    }
}
```

> **Adaptation note:** `tempfile` and `filetime` are NOT declared dev-dependencies of `apps/agent`. Use the in-file `temp_dir_for_test()` helper pattern (as established in Task 2) and `std::fs::File::set_times` (std, stable since Rust 1.75; rust-version is 1.85) for the mtime backdating. Preserve the test assertions exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/agent/Cargo.toml files::tests_throughput_resume`  
Expected: FAIL.

- [ ] **Step 3: Implement window update, binary transport, ack batching, pause/resume state machine, and janitor**

In `apps/agent/src/files.rs`:
- Update `FILE_WINDOW_CHUNKS` to 64.
- Switch `pump_download` from base64 JSON `Outbound::DownloadChunk` to binary frames (`encode_files_binary_frame`, type `BINARY_TYPE_DOWNLOAD_CHUNK`); the `Outbound` enum gains a raw-bytes variant.
- Accept inbound binary upload frames: wire the session dispatch into `handle_upload_chunk` via `decode_files_binary_frame` (type `BINARY_TYPE_UPLOAD_CHUNK`).
- Add ack batching per ADR-37: `ACK_FREQUENCY_CHUNKS: u64 = 16`, `ACK_FLUSH_INTERVAL: Duration = 20ms`; acks are cumulative (highest contiguous chunk index) and flush every 16 chunks or every 20 ms, whichever first (replaces today's ack-every-chunk behavior).
- Update the existing `download_acks_gate_the_window` test for the new window: it currently pins 16 in-flight chunks ("begin + 16 chunks", `frames.len() == 17`).
- In `UploadState`: handle `files-pause` without deleting `.part`.
- Implement `verify_resume_upload` verifying `.part` length.
- Implement `clean_stale_part_files` scanning directory recursively for `.ponter-part` files.
- Fix the transfer-id codec per the GAP-H ruling (strip dashes before hex decode; re-insert dashes on encode) with a dashed-UUID regression test.
- Emit `files-resume-ack` per the GAP-G ruling (`approved` true/false + reason), with regression tests.
- Add download pause/resume per the GAP-J ruling (`DownloadState.paused`, seek on resume, `check_idle` skip-while-paused) with an offset-continuity test.

In `apps/agent/src/main.rs`:
- Change the files-session frame channel to carry text-or-binary payloads (enum).
- Poll task: branch on `msg.is_string` — text keeps the UTF-8 dispatch path; binary forwards the raw bytes to dispatch.
- Pump: `send_text` for JSON frames, `dc.send(BytesMut)` for binary frames.
- Update `handle_files_frame` to accept binary frames and return outbound frames that may be binary.

In `apps/agent/Cargo.toml`:
- Make `bytes = "1"` a dependency on all targets (currently non-musl only).

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/agent/Cargo.toml files::tests_throughput_resume`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(agent): binary transport, ack batching, pause/resume upload, window tuning, and 24h part file janitor" -- apps/agent/src/files.rs apps/agent/src/main.rs apps/agent/Cargo.toml
```

---

### Task 4: Client Binary Framing, Chunk Slicing & File Operations (`packages/file-core`)

**Files:**
- Create: `packages/file-core/src/binary.ts`
- Modify: `packages/file-core/src/client.ts`
- Modify: `packages/file-core/src/transfer.ts` (`DEFAULT_WINDOW_SIZE` 16 → 64)
- Test: `packages/file-core/test/binary.test.ts`
- Test: `packages/file-core/test/operations.test.ts`
- Modify: `packages/file-core/test/client.test.ts` (binary download replay + 64-window upload)
- Modify: `packages/file-core/test/transfer.test.ts` (window constant + expectations)

**Interfaces:**
- Consumes: Shared types from `packages/shared`; `DataChannelManager` (`@ponter/webrtc-core`) — `sendRaw(label, data)`, `onRawMessage(label, handler)` already exist and are the binary seams; no webrtc-core changes needed.
- Produces:
  - `packBinaryChunk(type: number, transferId: string, chunkIndex: number, data: Uint8Array): Uint8Array`
  - `unpackBinaryChunk(bytes: Uint8Array): { type: number; transferId: string; chunkIndex: number; data: Uint8Array }`
  - `FileClient.uploadStream(dir: string, file: File, onProgress?): TransferHandle` (slices chunks via `file.slice()`)
  - `FileClient.mkdir(dir: string, name: string): Promise<void>`
  - `FileClient.delete(path: string, recursive?: boolean): Promise<void>`
  - `FileClient.rename(oldPath: string, newPath: string): Promise<void>`
  - **Binary transport switch (GAP-B ruling — no other task owns this):** `FileClient` must speak the ADR-36 hybrid protocol end-to-end, matching the agent after Task 3:
    - Inbound: subscribe `onRawMessage('files', …)` alongside the existing typed `onMessage` — string data keeps the JSON path; `ArrayBuffer` data is `unpackBinaryChunk`ed; type `0x01` (`BINARY_TYPE_DOWNLOAD_CHUNK`) feeds the download path (bytes straight from the frame, NO base64).
    - Outbound: upload chunks are sent with `dataChannelManager.sendRaw('files', packBinaryChunk(BINARY_TYPE_UPLOAD_CHUNK, transferId, chunkIndex, slice))` instead of `sendJson('files-upload-chunk', …)`; `sendJson` stays for all control envelopes.
    - Chunk-index encoding: the wire carries a 16-byte UUID (RFC 4122, no dashes) — `packBinaryChunk` strips dashes for the frame, `unpackBinaryChunk` re-inserts them so the returned `transferId` is the dashed string.
    - Window: `DEFAULT_WINDOW_SIZE` 16 → 64 (ADR-37, spec §2.2). Update `test/transfer.test.ts`'s `expect(DEFAULT_WINDOW_SIZE).toBe(16)` and the `test/client.test.ts` upload test that pins the 16-chunk window fill.
    - `client.test.ts`'s download test currently replays base64 JSON `files-download-chunk` frames — rework it to emit binary frames through the fake manager's raw seam (extend `makeFakeManager()` with `sendRaw` capture + an `emitRaw(bytes)` helper).

- [ ] **Step 1: Write failing tests in `packages/file-core/test/binary.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { packBinaryChunk, unpackBinaryChunk } from '../src/binary';
import { BINARY_TYPE_UPLOAD_CHUNK } from '@ponter/shared';

describe('Binary Chunk Framing', () => {
  it('packs and unpacks binary chunks with exact offsets', () => {
    const transferId = '12345678-1234-4234-8234-123456789abc';
    const chunkIndex = 15;
    const payload = new Uint8Array([10, 20, 30, 40]);

    const packed = packBinaryChunk(BINARY_TYPE_UPLOAD_CHUNK, transferId, chunkIndex, payload);
    expect(packed.byteLength).toBe(25 + 4);

    const unpacked = unpackBinaryChunk(packed);
    expect(unpacked.type).toBe(BINARY_TYPE_UPLOAD_CHUNK);
    expect(unpacked.transferId).toBe(transferId);
    expect(unpacked.chunkIndex).toBe(chunkIndex);
    expect(Array.from(unpacked.data)).toEqual([10, 20, 30, 40]);
  });

  it('rejects frames with length < 25', () => {
    expect(() => unpackBinaryChunk(new Uint8Array(24))).toThrow(/truncated/i);
  });

  it('rejects frames with length > 25 + 32768 (oversized payload)', () => {
    expect(() => unpackBinaryChunk(new Uint8Array(25 + 32768 + 1))).toThrow(
      /oversized/i,
    );
  });
});
```

Also write `packages/file-core/test/operations.test.ts` — one test per operation (`mkdir`, `delete`, `rename`, `uploadStream`), each asserting the outgoing frame shape against the shared types and resolving on the agent's reply. Mirror `test/client.test.ts`'s `makeFakeManager()`:

```typescript
it('sends files-mkdir and resolves on files-action-result', async () => {
  const fake = makeFakeManager();
  const client = new FileClient('ag-1', fake.manager);
  const promise = client.mkdir('docs', 'new');
  const frame = fake.sent.at(-1);
  expect(frame).toMatchObject({
    label: 'files',
    type: 'files-mkdir',
    payload: { dir: 'docs', name: 'new' },
  });
  fake.emit('files-action-result', {
    requestId: frame?.payload.requestId,
    action: 'mkdir',
    success: true,
  });
  await expect(promise).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/file-core test`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement binary codec in `packages/file-core/src/binary.ts` and operations in `packages/file-core/src/client.ts`**

- Use `crypto.randomUUID()` and DataView to pack/unpack 16-byte UUID and 64-bit integer chunk index (strip/re-insert dashes; `BigInt` for the u64 write, `Number` is safe for chunk indices in practice but write via `setBigUint64` and read via `getBigUint64` + `Number()`).
- Enforce BOTH frame-length bounds in `unpackBinaryChunk` per spec §5.4: length `< 25` → throw `/truncated/i`; length `> 25 + 32768 = 32793` → throw (oversized payload). Reuse `BINARY_HEADER_LEN` and `FILE_CHUNK_BYTES` from shared.
- Add `mkdir`, `delete`, `rename`, and `uploadStream` using chunk slicing to `FileClient`.
- Switch the existing download receive path and upload send path to binary per the Interfaces block (GAP-B): `onRawMessage` subscription for `ArrayBuffer` frames, `sendRaw` + `packBinaryChunk` for upload chunks, base64 helpers deleted once unused.
- Bump `DEFAULT_WINDOW_SIZE` to 64 and update the tests it breaks (`transfer.test.ts` constant assertion; `client.test.ts` window-fill and base64 replay tests).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/file-core test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(file-core): implement binary chunk framing, chunk slicing, and directory operations" -- packages/file-core/src/binary.ts packages/file-core/src/client.ts packages/file-core/src/transfer.ts packages/file-core/test/binary.test.ts packages/file-core/test/operations.test.ts packages/file-core/test/client.test.ts packages/file-core/test/transfer.test.ts
```

---

### Task 5: Client Pause/Resume & Service Worker Streaming (`packages/file-core` & `apps/web`)

**Files:**
- Create: `apps/web/public/sw-files-download.js`
- Create: `packages/file-core/src/sw-writer.ts`
- Modify: `packages/file-core/src/client.ts`
- Modify: `apps/web/src/stores/terminal.ts` (SW download routing — see Interfaces; GAP-D ruling)
- Modify: `apps/web/src/lib/file-errors.ts` (GAP-E ruling — add the four new error codes' UI text)
- Modify: `packages/shared/src/types/files.ts` (GAP-F ruling — prettier format fix only, no semantic change)
- Test: `packages/file-core/test/pause-resume.test.ts`

**Interfaces:**
- Produces:
  - `ServiceWorkerStreamWriter` managing `MessageChannel` streaming.
  - `FileClient.pauseTransfer(transferId: string, direction: 'upload' | 'download'): Promise<void>` — resolves on `files-pause-ack`. (2-arg: `direction` is required by `FilesPauseMessage`; the Interfaces block previously said 1-arg — the wire type wins.)
  - `FileClient.resumeTransfer(transferId: string, fromChunkIndex: number): Promise<void>` — the client looks up `direction` and `path` from the transfer it tracked at `download()`/`upload()` time; sends `FilesResumeRequest`; resolves on `files-resume-ack` with `approved: true`, rejects with `FilesError('RESUME_INVALID')` when `approved: false` (reason carried in the message).
  - `FileClient.download(path, onProgress?, onChunk?: (chunk: Uint8Array) => void)` — when `onChunk` is provided, each decoded chunk is forwarded as it arrives and NOT retained in memory (spec AC#3: <50 MB during a 500 MB transfer); `done` resolves `void` in that mode. Without `onChunk`, behavior is unchanged (assembled `Uint8Array`).
  - **SW download routing (GAP-D ruling — the writer needs a consumer or ADR-38 delivers nothing):** `terminal.ts` wires the SW path into `filesDownload`:
    - Route pinned: `/files-download-stream/:transferId/:filename` (plan Global Constraints + spec §4.3.1; the `/api/virtual-download` spelling in spec ADR-38's decision bullet is the stale variant).
    - Handshake: page posts `{ type: 'STREAM_INIT', transferId, filename, size }` with a `MessagePort` to the active SW; then navigates to the stream URL; per-chunk `{ type: 'CHUNK', chunk }` and a final `{ type: 'END' }` flow over the port. SW's fetch handler matches the route, looks up the port by transferId, and responds with a `ReadableStream` + `Content-Disposition`/`Content-Length`/`Content-Type` headers.
    - Fallback (spec ADR-38): SW unsupported or registration failed → existing in-memory `saveBlob` path for files ≤ 200 MB; surface a warning for larger files.
    - Registration is lazy (first files download), feature-detected (`navigator.serviceWorker`), and never throws into the download path.
  - **Error-text coverage (GAP-E ruling — Task 1 widened `FilesErrorCode` with `RESUME_INVALID`, `DIR_NOT_EMPTY`, `PERMISSION_DENIED`, `QUEUE_FULL`; no task owned `apps/web/src/lib/file-errors.ts`, so `Record<FileClientErrorCode, string>` lost four keys and `vue-tsc --noEmit` fails with TS2739):** add the four entries to `FILE_ERROR_TEXT` in `apps/web/src/lib/file-errors.ts`, in the existing voice:
    - `RESUME_INVALID: 'The file changed on the agent — the transfer cannot resume'`
    - `DIR_NOT_EMPTY: 'That folder is not empty'`
    - `PERMISSION_DENIED: 'The agent refused that operation'`
    - `QUEUE_FULL: 'Too many transfers are queued'`
  - **Format fix (GAP-F ruling — Task 1 committed `packages/shared/src/types/files.ts` with a multi-line `QueueItemStatus` union that fails `prettier --check`; `pnpm format:check` is a gating CI step (`ci-node.yml`), so the branch would go red):** run `pnpm exec prettier --write packages/shared/src/types/files.ts` and include the reformatted file in this task's commit. **Formatting only — do not change any type, value, or ordering.** Verify with `pnpm exec prettier --check packages/shared/src/types/files.ts`.

- [ ] **Step 1: Write failing test in `packages/file-core/test/pause-resume.test.ts`**

> **Mock shape:** `FileClient`'s constructor takes a `DataChannelManager` (`sendJson(label, type, payload)` + `onMessage(label, handler)`), not a raw channel. Reuse the `makeFakeManager()` fake from `test/client.test.ts` (copy it into this file — it is small) and assert on the captured frames.

```typescript
import { describe, it, expect, vi } from 'vitest';
import { FileClient } from '../src/client';

// makeFakeManager(): same shape as test/client.test.ts — captures sendJson
// frames into `sent` and exposes emit(type, payload) to replay agent frames.

describe('FileClient Pause and Resume', () => {
  it('sends files-pause frame and settles on pause ack', async () => {
    const fake = makeFakeManager();
    const client = new FileClient('ag-1', fake.manager);

    // Start an upload so the transfer is tracked, then pause it.
    const handle = client.upload('docs', 'f.bin', new Uint8Array(64));
    const pausePromise = client.pauseTransfer(handle.transferId, 'upload');

    const frame = fake.sent.at(-1);
    expect(frame).toMatchObject({
      label: 'files',
      type: 'files-pause',
      payload: { transferId: handle.transferId, direction: 'upload' },
    });

    // Replay the ack; the promise settles.
    fake.emit('files-pause-ack', {
      transferId: handle.transferId,
      ackedChunkIndex: 0,
      bytesTransferred: 0,
    });
    await expect(pausePromise).resolves.toBeUndefined();
  });

  it('tears down cleanly when the stream port closes mid-transfer (Review Focus #4)', async () => {
    // ServiceWorkerStreamWriter over a mock MessagePort pair; close the far
    // port after the first chunk. The next writeChunk/end must reject (or the
    // writer must expose a settled/aborted state) and release its port —
    // no dangling channels, no unhandled rejection.
    const { writer, farPort } = makeMockStreamWriter();
    await writer.writeChunk(new Uint8Array([1, 2, 3]));
    farPort.close();
    await expect(writer.end()).rejects.toThrow();
    expect(writer.isClosed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/file-core test`  
Expected: FAIL with `pauseTransfer` not defined.

- [ ] **Step 3: Implement Service Worker and pause/resume methods**

- Write `apps/web/public/sw-files-download.js` intercepting the `/files-download-stream/:transferId/:filename` route (MessagePort chunk forwarding → ReadableStream response with `Content-Disposition`, `Content-Length`, `Content-Type: application/octet-stream`).
- Implement `ServiceWorkerStreamWriter` and `pauseTransfer` / `resumeTransfer` in `FileClient`.
- Add the optional `onChunk` streaming callback to `FileClient.download()` (chunk-forwarding mode, no in-memory buffer).
- Wire `terminal.ts`'s `filesDownload` to the SW path with the ≤200 MB Blob fallback (GAP-D ruling in Interfaces): lazy, feature-detected registration; on registration/stream failure fall back to `saveBlob`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/file-core test`  
Expected: PASS.

Also run `pnpm --filter @ponter/web typecheck` — it must exit 0 once `file-errors.ts` covers the four new codes (GAP-E). This is the only apps/web check this task owns. And run `pnpm exec prettier --check packages/shared/src/types/files.ts` — must exit 0 (GAP-F).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(file-core): add Service Worker disk stream writer and pause/resume client support" -- apps/web/public/sw-files-download.js apps/web/src/stores/terminal.ts apps/web/src/lib/file-errors.ts packages/shared/src/types/files.ts packages/file-core/src/sw-writer.ts packages/file-core/src/client.ts packages/file-core/test/pause-resume.test.ts
```

---

### Task 6: Web Transfer Queue Store (`apps/web`)

**Files:**
- Create: `apps/web/src/stores/transfer-queue.ts`
- Test: `apps/web/src/__tests__/transfer-queue.test.ts`

**Interfaces:**
- Produces: Pinia store `useTransferQueueStore` maintaining queue state, concurrency gate (1 active upload + 1 active download), rolling speed metrics, and ETA.

- [ ] **Step 1: Write failing unit test in `apps/web/src/__tests__/transfer-queue.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTransferQueueStore } from '../stores/transfer-queue';

describe('Transfer Queue Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('enqueues transfers and starts exactly one active upload', () => {
    const store = useTransferQueueStore();
    store.enqueue({ id: 't-1', name: 'f1.bin', path: 'f1.bin', size: 100, direction: 'upload' });
    store.enqueue({ id: 't-2', name: 'f2.bin', path: 'f2.bin', size: 200, direction: 'upload' });

    expect(store.items).toHaveLength(2);
    expect(store.activeUploadId).toBe('t-1');
    expect(store.items.find(i => i.id === 't-1')?.status).toBe('active');
    expect(store.items.find(i => i.id === 't-2')?.status).toBe('queued');
  });

  it('dequeues next upload when active upload completes', () => {
    const store = useTransferQueueStore();
    store.enqueue({ id: 't-1', name: 'f1.bin', path: 'f1.bin', size: 100, direction: 'upload' });
    store.enqueue({ id: 't-2', name: 'f2.bin', path: 'f2.bin', size: 200, direction: 'upload' });

    store.markCompleted('t-1');
    expect(store.activeUploadId).toBe('t-2');
    expect(store.items.find(i => i.id === 't-2')?.status).toBe('active');
  });

  it('enqueues a 20-file drop batch with exactly one active upload (Review Focus #5)', () => {
    const store = useTransferQueueStore();
    for (let i = 0; i < 20; i++) {
      store.enqueue({ id: `t-${i}`, name: `f${i}.bin`, path: `f${i}.bin`, size: 100, direction: 'upload' });
    }

    expect(store.items).toHaveLength(20);
    expect(store.items.filter(i => i.status === 'active')).toHaveLength(1);
    expect(store.activeUploadId).toBe('t-0');
    expect(store.items.filter(i => i.status === 'queued')).toHaveLength(19);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/web test src/__tests__/transfer-queue.test.ts`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `useTransferQueueStore`**

Implement store state, actions (`enqueue`, `pause`, `resume`, `cancel`, `markCompleted`, `updateProgress`), and auto-pump logic.

> **Notes:** `enqueue` takes a partial item (`id`, `name`, `path`, `size`, `direction`) and defaults `bytesTransferred: 0`, `speedBytesPerSec: 0`, `etaSeconds: null`, `status` per the concurrency gate. The store's `activeUploadId`/`activeDownloadId` getters are store-local names; the shared `QueueStatus` type (`activeUpload`/`activeDownload`) is the wire/persisted shape only — no need to rename the store's getters.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/web test src/__tests__/transfer-queue.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(web): implement transfer queue Pinia store with concurrency control" -- apps/web/src/stores/transfer-queue.ts apps/web/src/__tests__/transfer-queue.test.ts
```

---

### Task 7: Web UI: Drag & Drop, Transfer Queue Drawer & Sandboxed Actions (`apps/web`)

**Files:**
- Modify: `apps/web/src/components/files/FilesView.vue`
- Create: `apps/web/src/components/files/TransferQueueDrawer.vue`
- Create: `apps/web/src/components/files/NewFolderDialog.vue`
- Create: `apps/web/src/components/files/RenameDialog.vue`
- Create: `apps/web/src/components/files/DeleteConfirmDialog.vue`
- Modify: `apps/web/src/stores/terminal.ts` (add `filesMkdir`/`filesDelete`/`filesRename` actions + pause/resume/cancel-queue wiring — GAP-C ruling)
- Test: `apps/web/src/__tests__/FilesView.test.ts`

**Interfaces:**
- Consumes: `useTransferQueueStore`; `FileClient.mkdir/delete/rename/pauseTransfer/resumeTransfer` (Tasks 4-5).
- Produces: Enhanced `FilesView.vue` with drag & drop highlight, action dialogs, and expandable transfers drawer; store actions `filesMkdir(tabId, name)`, `filesDelete(tabId, path, recursive?)`, `filesRename(tabId, oldPath, newPath)` — each delegates to the tab's `FileClient`, re-lists the current directory on success (`filesNavigate`), and maps failures to `tab.fileError` (GAP-C ruling: Task 7's Interfaces named these as consumed but no task created them).

- [ ] **Step 1: Write failing component tests in `apps/web/src/__tests__/FilesView.test.ts`**

> **Shape note:** `FilesView.vue` takes a single `tab: TabItem` prop (see the existing suite's `filesTab()` helper and `mountFiles()`), NOT a `tabId`. Extend the existing test file — reuse its helpers rather than rewriting.

```typescript
// Append to the existing FilesView.test.ts (reusing its filesTab/mountFiles helpers).
describe('FilesView Advanced UI (Week 11)', () => {
  it('renders New Folder and Transfers toolbar buttons', () => {
    const wrapper = mountFiles();
    expect(wrapper.find('[data-test="files-new-folder-btn"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="files-transfers-btn"]').exists()).toBe(true);
  });

  it('triggers dragover visual state when dragging files over table', async () => {
    const wrapper = mountFiles();
    const dropzone = wrapper.find('[data-test="files-dropzone"]');
    await dropzone.trigger('dragover');
    expect(wrapper.classes()).toContain('drag-active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/web test src/__tests__/FilesView.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement components & update `FilesView.vue`**

- Add drag & drop event handlers (`@dragover`, `@dragleave`, `@drop`) — `drop` extracts `DataTransfer.files` and routes each through `store.filesUpload(tab.id, file)`.
- Add dialogs for New Folder, Rename, and Delete Confirmation — wired to `store.filesMkdir/filesRename/filesDelete`.
- Integrate `TransferQueueDrawer.vue` with progress bars, MB/s speed, ETA, and Pause/Resume/Cancel buttons (pause/resume via `store.filesPauseTransfer/filesResumeTransfer`).
- Add the store actions (`filesMkdir`, `filesDelete`, `filesRename`, `filesPauseTransfer`, `filesResumeTransfer`) to `terminal.ts` per the Interfaces block, and export them from the store's return object.
- Add row actions: Rename and Delete on each row (Delete opens the confirm dialog; directories pass `recursive` after confirmation).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/web test src/__tests__/FilesView.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(web): add drag-and-drop, transfer queue drawer, and file operation dialogs" -- apps/web/src/components/files/ apps/web/src/stores/terminal.ts apps/web/src/__tests__/FilesView.test.ts
```

---

### Task 8: End-to-End Test Suite (`packages/webrtc-core`)

**Files:**
- Create: `packages/webrtc-core/test/e2e/files-advanced.e2e.test.ts`
- Modify: `packages/webrtc-core/test/e2e/harness.ts`
- Modify: `packages/webrtc-core/test/e2e/files.e2e.test.ts` (Week 10 suite must be updated for Week 11: `WINDOW` 16 → 64, base64 JSON chunk assertions → binary frames, and the cancel test's `WINDOW + 1` no-show pin reworked for the new window)

**Interfaces:**
- Produces: E2E test verifying (against the real agent over werift):
  1. Sustained throughput >10 MB/s on a large (50 MB) transfer.
  2. Binary framing byte-level integrity (SHA-256 equality both directions).
  3. Pause and resume upload (and download) — offset continuity, `.part` retained.
  4. Sandboxed directory operations (`mkdir`, `rename`, `delete`) including the escape-refusal path.
  5. Queue concurrency limit — **owned by Task 6's unit tests, NOT here**: this suite is Node/werift and has no Vue/Pinia runtime. Do not attempt to import the queue store.
- Harness additions (`harness.ts`): capture inbound binary frames via `dataChannels.onRawMessage('files', …)` (ArrayBuffer → `Uint8Array`) alongside the existing JSON `frames` array; export a `sendRaw` helper (`offerer.dataChannels.sendRaw('files', bytes)`); a small `packBinary`/`unpackBinary` local helper mirroring the client codec (25-byte header, UUID dash handling) so the suite does not depend on `packages/file-core`'s browser-oriented module.
- Wire reminder: after Tasks 3-4 the agent sends download chunks as binary `0x01` frames and expects upload chunks as binary `0x02` frames — the Week 10 suite's base64 JSON replays no longer match the agent; this suite and the updated `files.e2e.test.ts` must speak the binary protocol. Ack frames stay JSON (`files-download-ack` / `files-upload-ack`).

- [ ] **Step 1: Write E2E test suite in `packages/webrtc-core/test/e2e/files-advanced.e2e.test.ts`**

Implement automated test cases executing against the live native Rust agent with `--files-root` enabled.

- [ ] **Step 2: Run E2E test to verify it fails / passes**

Run: `pnpm --filter @ponter/webrtc-core test test/e2e/files-advanced.e2e.test.ts`  
Expected: PASS once Tasks 1-7 are integrated.

- [ ] **Step 3: Commit**

```bash
git commit -m "test(e2e): add Phase 4 Week 11 advanced file transfer e2e test suite" -- packages/webrtc-core/test/e2e/files-advanced.e2e.test.ts packages/webrtc-core/test/e2e/files.e2e.test.ts packages/webrtc-core/test/e2e/harness.ts
```

---

### Task 9: Documentation Reconciliation & Demo (`docs/`)

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/guides/agent-setup.md`
- Create: `docs/demos/2026-10-05-phase4-week11-demo.md`

- [ ] **Step 1: Update `docs/ARCHITECTURE.md`**

Mark Phase 4 File Transfer as completely finished (`[x]` for Week 10 & Week 11). Document ADR-36 to ADR-40.

- [ ] **Step 2: Update `docs/guides/agent-setup.md`**

Add operational guidelines for `--files-root`, 24-hour part file TTL cleanup, and directory permissions.

- [ ] **Step 3: Write demo walkthrough script**

Document step-by-step commands to demonstrate drag & drop, queue, pause/resume, and >10 MB/s throughput.

- [ ] **Step 4: Commit**

```bash
git commit -m "docs: reconcile Phase 4 Week 11 architecture, setup guide, and demo walkthrough" -- docs/ARCHITECTURE.md docs/guides/agent-setup.md docs/demos/2026-10-05-phase4-week11-demo.md
```

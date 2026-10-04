# Phase 4 Week 11 — File Transfer Demo Walkthrough

**Date:** 2026-10-05
**Machine:** Fedora Linux (X11), loopback WebRTC for throughput
**Agent:** `apps/agent` built debug via `cargo build --manifest-path apps/agent/Cargo.toml`; web at `apps/web`
**Branch HEAD:** `feat/phase4-week11-file-transfer`

## Status

**Not observed manually.** This walkthrough is a *runnable script*: each step is the command(s) you would run and the observation you would make. The throughput figure in step 6 is **not** a manual stopwatch number — it is the measured result from the E2E suite `packages/webrtc-core/test/e2e/files-advanced.e2e.test.ts` (test 3, assertion `> 10 MB/s`), which is the exclusive source of the `~11–14 MB/s` figure cited here. The Week 11 code tasks (3–8) implement and assert this; this doc (Task 9) is docs-only and reconciles the architecture, not a re-measurement.

## Security posture (unchanged from Week 10)

- **No E2EE on file bytes.** File names and payloads cross the wire under DTLS only (H11/M7/M8). Application-layer encryption is `WS1` (Phase 5).
- **Peer is unverified.** The agent does not verify the client (H3); `approved` is not enforced (H2). The `--files-root` gate is a policy holding pattern closed by `WS1/WS2/WS3`.
- File access crosses only to a peer that passed the gate (root offered). There is no peer identity and no application-layer encryption yet.

---

## Steps

### 1. Start the agent with the files sandbox open

```bash
# Build the agent (debug), then run with --files-root pointed at a scratch dir.
# (No root Cargo.toml exists; use the agent crate manifest directly.)
cargo build --manifest-path apps/agent/Cargo.toml
mkdir -p /tmp/ponter-demo-files
./apps/agent/target/debug/ponter-agent \
  --agent-id agent-myhost-01 \
  --server ws://localhost:8787/api/ws/agent \
  --credential ag_0123456789abcdef0123456789abcdef \
  --stun "" \
  --files-root /tmp/ponter-demo-files
```

**Expected observation:**
- Agent log line `starting ponter-agent` (INFO); on connect, INFO `connected to the signaling server`. There is **no** per-root success log line — the files gate is observable only when the browser later offers (Step 2), via the server log / browser, at which point an open root is answered with `approved: true` for file sessions.
- If the root were bad, the agent would log WARN `files root unusable` (at startup) and, on offer, WARN `refused: files root not configured or unusable` with the peer closed.
- In `/tmp/ponter-demo-files`, seed a couple of fixtures so listing is non-empty:
  ```bash
  mkdir -p /tmp/ponter-demo-files/inbox /tmp/ponter-demo-files/archive
  head -c 1000 /dev/urandom > /tmp/ponter-demo-files/hello-1k.bin
  ```

### 2. Open the web client and the Files tab

Navigate to the local web client (e.g. `http://localhost:3000`), connect, and open the **`Files`** tab.

**Expected observation:**
- The breadcrumb shows the sandbox root (`/`), and the file list shows `hello-1k.bin`, `inbox/`, `archive/`. This is the `files-list` result arriving as a JSON text frame over the `'files'` data channel.

### 3. Drag & drop a batch upload (queue: 1 active + FIFO)

Create a ~5 MiB fixture and drag it onto the Files view drop zone (or use the OS file picker into the table).

```bash
# Prepare a larger fixture to make throughput meaningful (used by step 6 as well).
head -c 5242880 /dev/urandom > /tmp/ponter-demo-files/upload-5mb.bin
# From the desktop/WebUI: drag upload-5mb.bin (and hello-1k.bin) into the Files tab.
```

**Expected observation:**
- A **Transfer Queue** drawer entry appears for each dropped file. State machine: `QUEUED` → `ACTIVE` → `COMPLETED`.
- Concurrency is capped at **1 active upload + 1 active download**: the first dropped file is `ACTIVE`, the others sit `QUEUED` in FIFO order. Real-time speed (MB/s) and ETA update per second.
- On upload, the shipped web path reads the **whole file into tab memory first**:
  `apps/web/src/stores/terminal.ts` does `new Uint8Array(await file.arrayBuffer())`
  (`terminal.ts:1325`), then hands that `Uint8Array` to `client.upload(...)`. The
  chunker in `packages/file-core/src/client.ts:290-291` slices that in-memory
  buffer with `Uint8Array.slice(start, start + FILE_CHUNK_BYTES)` — **not**
  `File.slice()` — so tab memory is proportional to the file size, not bounded.
  The **~2 MiB** figure describes the **wire window** (64 chunks of 32 KiB in
  flight), not the tab's total memory. (Note: a separate `uploadStream` API in
  `client.ts:350` *does* use `File.slice()` and never reads the whole file, but
  it is **not wired into the web app** — only referenced by
  `packages/file-core/test/operations.test.ts`. This diverges from spec ADR-38
  item 4 / AC #3, which called for streaming upload; the controller is flagging
  it separately.) Each data chunk goes out as a **binary frame** (`0x02`) with
  the 25-byte header (type + 16-byte transfer ID + 8-byte BE chunk index), not
  Base64.
- On completion, the agent writes `{name}.ponter-part` then **atomically renames**
  to the final name; no `.part` remains (asserted by the Week 10 E2E
  `uploads a 100 KiB file ... with no .part left behind`).

### 4. Pause / resume (upload keeps an agent-side `.ponter-part`)

Re-drop `upload-5mb.bin` into the Files tab to start a fresh **upload**, then
immediately click **Pause**.

**Expected observation:**
- Transfer state → `PAUSED`. Network chunk frames stop.
- Because pause applies to an **upload**, the agent flushes + fsyncs the
  partial write so the part is durable, then keeps
  `/tmp/ponter-demo-files/upload-5mb.bin.ponter-part` on disk. It is **not**
  deleted on pause — only on explicit `files-cancel` (immediate) or 24 h TTL
  expiry. This is resumable state.
- Click **Resume**.
- The client sends `files-resume` with `fromChunkIndex`. The agent validates that
  the `.part` length == `fromChunkIndex * FILE_CHUNK_BYTES`
  (`files.rs:1945-1956`) before acknowledging (`files-resume-ack`,
  `approved: true`), then **re-opens the `.part` in append mode** so the resumed
  stream continues from that offset (`files.rs:1958`). Transfer continues to
  `COMPLETED` without restarting.

> Note on direction: `.ponter-part` is an **upload-only** mechanism. Downloads
> are read-only on the agent — `files.rs:1854` ("Downloads are read-only: no
> flush/fsync, no .part to delete") — so a paused download keeps no `.part`;
> resume simply seeks the read cursor forward. See
> `docs/guides/agent-setup.md` (section 3.1).

> Note on TTL: leave the `.ponter-part` in place. The agent janitor runs hourly
> (and on startup) and removes `.ponter-part` files whose `modified()` time is
> older than 86400 s (24 h). Parts younger than 24 h are resumable state and must
> not be hand-deleted mid-transfer. Explicit `files-cancel` deletes the part
> immediately regardless of age.

### 5. Basic sandboxed ops (mkdir / rename / delete)

From the Files tab toolbar/row actions:

**(a) New folder** — click **New Folder**, enter `batch-export`, confirm.
- **Expected:** `files-mkdir` JSON control frame is sent; a directory `batch-export/` appears in the listing.

**(b) Rename** — click the **pencil (✏) button in the Actions column** of `hello-1k.bin`, enter `hello-renamed.1k` in the inline prompt, confirm.
- **Expected:** `files-rename` frame sent with `oldPath`/`newPath`. Because the typed name is used as-is (no path join — `onRenameConfirm` sends `name`, the exact text typed), the renamed file becomes **`hello-renamed.1k`** (not `hello-renamed.1k.bin`). No overwrite ever — if the new name already exists, the agent returns `FILE_EXISTS`.

**(c) Delete a file** — select `hello-renamed.1k` → **Delete** → confirm.
- **Expected:** a `DeleteConfirmDialog` appears; confirming emits `files-delete` with `recursive = isDirectory` (a **directory** delete carries `recursive: true`; a **file** delete carries `recursive: false`, since `isDirectory` is `false` for files — `DeleteConfirmDialog.vue:36`); the file is removed and the listing refreshes. (Via the raw API without the dialog, deleting a non-empty directory without `recursive: true` returns `DIR_NOT_EMPTY`.)

**(d) Delete a non-empty directory** — select `archive/` (seed it with one file first) → **Delete** → confirm the recursive dialog.
- **Expected:** the `DeleteConfirmDialog` confirm emits `files-delete` with `recursive: true`; the directory is removed. Without the confirm / without `recursive: true` (API path), the agent returns `DIR_NOT_EMPTY`.
- **Expected (root refusal):** attempting to delete the root (`path == ""`) is rejected with `PERMISSION_DENIED` — the root itself can never be deleted or renamed.

All of (a)–(d) are confined to `/tmp/ponter-demo-files`; `..` traversal and symlink escapes are canonicalized+prefix-checked and rejected.

### 6. Large-file throughput (>10 MB/s) — cited result, not re-measured here

The Week 11 throughput criterion is met by the **hybrid binary protocol**: JSON text frames for control + raw binary chunk frames (25-byte header, 32 KiB payload), sliding window of 64 chunks (~2 MiB in-flight), cumulative acks every 16 chunks or 20 ms.

**Measured result (source of truth):** the E2E suite `packages/webrtc-core/test/e2e/files-advanced.e2e.test.ts`, inside the `files advanced E2E` describe block, **test 3** whose `it()` title is `sustained download throughput > 10 MB/s on a 50 MiB transfer`. On loopback this records:

> ~11–14 MB/s isolated (samples 11.16 / 14.12 / 11.08 / 14.28 / 14.19 / 13.82 MB/s; 50 MiB over 1600 chunks; timed with `process.hrtime.bigint()` from the `files-download` event to `files-download-end`; agent built debug via `cargo build --manifest-path apps/agent/Cargo.toml`).

To reproduce locally (this is the command the suite runs; you do **not** need to re-run to "prove" the number — cite the suite):

```bash
# Run the specific E2E throughput assertion. (Docs-only task — do not run here, but this is the command.)
pnpm --filter @ponter/webrtc-core test:e2e files-advanced
# then, in the suite output, look for: "files advanced E2E ... sustained download throughput > 10 MB/s ..."
```

**Expected observation:** the suite reports the `> 10 MB/s` assertion passing, with the measured samples above. Cite that number verbatim — do **not** round up or extrapolate. Honest caveat: under concurrent load the same path drops to ~7–9 MB/s; the >10 MB/s figure is for an isolated single transfer on loopback.

### 7. SW streaming download to disk (no in-memory blowup)

Pick a large file (e.g. a ~200 MB fixture in the sandbox) and click download.

**Expected observation:**
- The web client navigates the browser to the virtual stream URL `/files-download-stream/${transferId}/${encodeURIComponent(filename)}`.
- The registered Service Worker `apps/web/public/sw-files-download.js` intercepts that route (see `sw-files-download.js:29`, `parts[1] === 'files-download-stream'`).
- The SW returns a `Response` wrapping a `ReadableStream` with headers:
  - `Content-Disposition: attachment; filename="<filename>"`
  - `Content-Type: application/octet-stream`
  - `Content-Length` is **omitted**: the writer is constructed with `size: 0`
    (`terminal.ts:1256`) and `initDownloadStream(..., 0, port2)` (`terminal.ts:1279`),
    so the SW only sets `Content-Length` when `size > 0`
    (`sw-files-download.js:66-68`) — which is never the case here.
- Incoming binary download chunks (`0x01` frames) are forwarded over a `MessageChannel` `MessagePort` to the stream controller, which pipes to the native OS save dialog. The browser writes straight to disk — **tab memory stays flat**, not proportional to file size.
- **Fallback:** if SW registration fails (e.g. private/incognito), the client falls back to in-memory Blob assembly but only for files ≤ 200 MB; larger files surface a warning.

---

## What this demonstrates end-to-end

| Capability | Where it's shown | Mechanism |
|---|---|---|
| Batch upload, FIFO queue, 1+1 concurrency | Step 3 | Transfer queue store, binary `0x02` frames |
| Pause/resume with kept `.part` | Step 4 | `files-pause`/`files-resume`, length validation |
| Sandbox mk dir / rename / delete | Step 5 | `files-mkdir`/`files-rename`/`files-delete`, `PERMISSION_DENIED`/`DIR_NOT_EMPTY`/`FILE_EXISTS` |
| Large-file throughput >10 MB/s | Step 6 | Window-64 hybrid binary (ADR-36/37), E2E `files-advanced.e2e.test.ts` test 3 |
| Disk streaming, flat memory | Step 7 | SW `/files-download-stream/:transferId/:filename` + `ReadableStream` |

## Non-goals / out of scope here

- Throughput is **cited** from the E2E suite, not re-measured in this doc (docs-only task; no test runs).
- E2EE and peer-identity remain Phase 5 (`WS1`/`WS2`/`WS3`); file bytes ride DTLS only. See `docs/security/2026-10-01-e2ee-zero-trust-audit.md`.

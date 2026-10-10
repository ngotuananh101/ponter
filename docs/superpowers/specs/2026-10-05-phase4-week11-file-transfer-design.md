# Phase 4 Week 11 — File Transfer Hardening, Streaming, Queue, Pause/Resume & High Throughput Design Specification

**Status:** Draft — Ready for review  
**Date:** 2026-10-05  
**Author:** Ngo Tuan Anh & Claude  
**Target:** Phase 4 Week 11 of `docs/ARCHITECTURE.md` (`:1003-1020`, "Phase 4: File Transfer (Weeks 10-11)"). Week 11 completes the full Phase 4 feature set: streaming large files directly to disk, transfer queue with drag & drop, pause & resume protocol with part file lifecycle, basic file operations (`mkdir`, `delete`, `rename`), and WebRTC DataChannel throughput optimization (>10 MB/s) via hybrid binary multiplexing.

---

## 1. Overview & Objectives

In Week 10 (merged in PR #40 @ `e0e1137`), the foundation of File Transfer was established: the third session mode `Files` with data channel label `'files'`, the agent-side sandbox `--files-root` with refuse-at-offer gating (ADR-32, ADR-33), and a thin slice supporting listing, sequential download, and sequential upload.

However, Week 10 had explicit intentional constraints:
- **Memory footprint:** Download assembled all chunks into a memory `Blob`; upload loaded the entire file into memory via `File.arrayBuffer()`. Large files (>500 MB to 1 GiB) risked browser tab crashes (OOM).
- **Wire overhead:** Chunks were encoded as Base64 inside JSON envelopes, causing a 33% bandwidth overhead and heavy JSON/string parse cycles under high throughput.
- **Limited interaction:** Single transfer per direction, no transfer queue, no drag-and-drop, and cancelling aborted the entire transfer with no ability to resume.
- **Limited file operations:** Listing was the only directory operation; users could not create directories, delete files, or rename items.

Week 11 resolves all these limitations, delivering production-grade file management and robust high-speed transfers.

### 1.1 Core Goals

1. **Hybrid Multiplexing Wire Protocol (ADR-36):** Preserve JSON envelopes for control messages (`files-list`, `files-upload-begin`, `files-pause`, etc.) while transmitting data chunks as raw **Binary Frames** on the `'files'` data channel. Eliminates Base64 inflation and JSON serialization overhead for file payloads.
2. **Throughput Optimization >10 MB/s (ADR-37):** Increase the sliding window from 16 to **64 chunks** (~2 MiB in-flight data) with cumulative acknowledgements every 16 chunks or 20 ms.
3. **Browser Direct-to-Disk Streaming via Service Worker (ADR-38):** Register a dedicated Service Worker (`/sw-files-download.js`) intercepting download requests with streaming `ReadableStream` responses, allowing multi-gigabyte downloads directly to the user's Downloads folder with minimal RAM usage.
4. **Client-Side Chunk Slicing for Uploads:** Stream uploads using `File.slice()` per chunk, keeping tab memory bounded under ~2 MiB regardless of file size.
5. **Transfer Queue & Drag-and-Drop (ADR-39):** UI support for dragging and dropping single or multiple files/folders; a centralized transfer queue managing states (`QUEUED`, `ACTIVE`, `PAUSED`, `COMPLETED`, `CANCELLED`, `FAILED`) with real-time speed (MB/s) and ETA calculations. Enforce concurrency of 1 active upload + 1 active download at a time.
6. **Pause & Resume Protocol with 24-Hour Part File TTL (ADR-39):** Allow users or network drops to pause transfers and resume from `fromChunkIndex`. Upload `.ponter-part` files are retained across interruptions and cleaned up via an agent janitor task after a 24-hour TTL.
7. **Basic Sandboxed File Operations (ADR-40):** Wire and UI support for creating folders (`files-mkdir`), deleting files/directories (`files-delete`), and renaming items (`files-rename`), all strictly enforced within the sandbox root without overwrite.

### 1.2 Non-Goals (Explicitly Deferred)

- **Application-layer E2EE for file bytes:** Traffic continues to rely on WebRTC DTLS encryption (H11/M7/M8). Application-layer encryption is scheduled for **WS1** in Phase 5 (`docs/security/2026-10-01-e2ee-zero-trust-audit.md`).
- **Peer identity and consent (H2/H3):** The gate (`--files-root`) remains a local policy gate. Cryptographic peer identity verification is scheduled for **WS2/WS3** in Phase 5.
- **Multi-channel parallel WebRTC streams:** Transfers run over the single `'files'` data channel. With 64-chunk windowing and binary framing, a single channel achieves 20–50 MB/s on LAN, satisfying the >10 MB/s requirement without multi-channel complexity.
- **Server changes:** The backend server remains 100% mode-agnostic and stateless regarding file payloads (ADR-35).

---

## 2. Architecture Decisions (ADR-36 to ADR-40)

### ADR-36: Hybrid Text/Binary Multiplexing on `'files'` Channel

- **Context:** WebRTC DataChannels support both UTF-8 string messages and binary `ArrayBuffer`/`Blob` messages on the same channel. Week 10 sent everything as UTF-8 JSON envelopes with Base64 payloads. Base64 expands 32 KiB binary chunks to ~43.7 KiB text, wasting 33% bandwidth and CPU.
- **Decision:** Multiplex control and data frames by message format:
  - **Text frames:** Parsed as JSON `DataChannelMessage<T>`. Used for all signaling, directory actions, begin/end handshake, pause, resume, cancel, and error notifications.
  - **Binary frames:** Handled as raw chunk data. Used exclusively for chunk payloads.
  - **Binary Frame Layout (25-byte header + payload):**
    ```
    +-------------------+-----------------------------------+-----------------------------------+----------------------------------+
    | Type (1 byte)     | Transfer ID (16 bytes)            | Chunk Index (8 bytes, Big-Endian) | Raw File Payload (up to 32 KiB)  |
    | 0x01 = Download   | UUID binary bytes (128-bit)       | u64 chunk index                   | Raw binary bytes                 |
    | 0x02 = Upload     |                                   |                                   |                                  |
    +-------------------+-----------------------------------+-----------------------------------+----------------------------------+
    ```
- **Consequences:** Eliminates Base64 encoding/decoding overhead. 32 KiB chunk becomes exactly 32,793 bytes on the wire, well below the 64 KiB SCTP message threshold. Backwards compatibility: if an unknown binary packet or text frame is received, it is discarded with a warning.

### ADR-37: Throughput Optimization (>10 MB/s Target)

- **Context:** In Week 10, a window of 16 chunks (512 KiB in-flight) with Base64 JSON achieved ~4–6 MB/s. To reliably exceed 10 MB/s across various network latencies, in-flight capacity and acknowledgement frequency must be optimized.
- **Decision:**
  - Increase `FILE_WINDOW_CHUNKS` from 16 to **64 chunks** (2,097,152 bytes ≈ 2 MiB in-flight data).
  - Use cumulative acks: the receiver emits `files-download-ack` or `files-upload-ack` every **16 chunks** received, or when an idle timer of **20 ms** expires if fewer than 16 chunks arrived.
  - The sender transmits as long as `(sent_chunk_index - acked_chunk_index) < 64`.
- **Consequences:** Sustains >20 MB/s on local connections and >10 MB/s across simulated 20ms RTT latency. Memory usage on both agent and web client is strictly bounded to 2 MiB in-flight buffer.

### ADR-38: Browser Disk Streaming via Service Worker

- **Context:** Downloading large files (>500 MB) into memory blobs causes high browser memory usage and can trigger tab crashes. The File System Access API (`showSaveFilePicker`) is Chromium-only and lacks Firefox support.
- **Decision:**
  - Introduce a dedicated service worker at `/sw-files-download.js`.
  - When a download begins, the Web app establishes a `MessageChannel` with the Service Worker and triggers navigation to a virtual stream URL: `/api/virtual-download/:transferId/:filename`.
  - The Service Worker intercepts this URL and returns a `Response` wrapping a `ReadableStream` with headers:
    - `Content-Disposition: attachment; filename="<filename>"`
    - `Content-Length: <filesize>`
    - `Content-Type: application/octet-stream`
  - As binary chunks arrive over WebRTC, the Web client forwards them via the `MessagePort` to the stream controller.
  - The browser streams the incoming data directly to the native OS Downloads folder.
  - **Fallback:** If Service Worker registration fails (e.g. private/incognito restrictions), fallback to in-memory Blob assembly for files ≤ 200 MB, and display a warning for larger files.

### ADR-39: Transfer Queue & Pause/Resume Protocol with 24-Hour Part File TTL

- **Context:** Large transfers can be interrupted by network glitches or user actions. Upload temp files (`.ponter-part`) were previously deleted immediately on any cancellation or disconnect.
- **Decision:**
  - **Transfer Queue:** Web UI manages a transfer queue with concurrency: max 1 active upload and 1 active download. Subsequent transfers queue in `QUEUED` state.
  - **Pause/Resume:**
    - On pause or disconnect, Agent flushes and leaves `{name}.ponter-part` on disk.
    - Resume handshake sends `fromChunkIndex`. Agent verifies `.part` length matches `fromChunkIndex * FILE_CHUNK_BYTES` before acknowledging resume.
    - Download resume seeks the source file to `fromChunkIndex * FILE_CHUNK_BYTES` and resumes binary chunk emission.
  - **24-Hour TTL Cleanup:**
    - Agent tracks last modification time of `.ponter-part` files.
    - A periodic background task (running hourly and on agent startup/session init) removes any `.ponter-part` files older than 24 hours. Explicit user cancellation (`files-cancel`) continues to delete the `.part` file immediately.

### ADR-40: Sandboxed Directory Management (`mkdir`, `delete`, `rename`)

- **Context:** Users need full file manager functionality (creating folders, deleting files, renaming items) without leaving the files view.
- **Decision:**
  - Extend the wire protocol with `files-mkdir`, `files-delete`, `files-rename`.
  - **Security Rules:**
    1. All paths must be POSIX-relative to the sandbox root, canonicalized, and checked against the root prefix.
    2. Deleting the root (`path == ""`) is strictly forbidden and rejected with `PERMISSION_DENIED`.
    3. Deleting directories: Non-empty directories require explicit `recursive: true` in the request, and UI requires a confirmation prompt.
    4. Renaming: Both `oldPath` and `newPath` must be within the sandbox root. Overwriting an existing destination is rejected with `FILE_EXISTS`.

---

## 3. Wire Protocol Specification

### 3.1 Frame Types Overview

Frames on the `'files'` data channel are categorized by transport format:

```
DataChannel 'files'
 ├── Text (UTF-8 JSON Envelopes)
 │    ├── Existing: files-list, files-list-result, files-upload-begin, files-upload-end,
 │    │             files-upload-ack, files-upload-complete, files-download,
 │    │             files-download-begin, files-download-end, files-download-ack,
 │    │             files-cancel, files-error
 │    └── New (Week 11):
 │         ├── files-pause, files-pause-ack
 │         ├── files-resume, files-resume-ack
 │         ├── files-mkdir, files-delete, files-rename
 │         └── files-action-result
 └── Binary (Raw ArrayBuffer / Uint8Array)
      ├── 0x01: Download Chunk (Agent -> Browser)
      └── 0x02: Upload Chunk   (Browser -> Agent)
```

### 3.2 Binary Frame Format Specification

Binary messages do not use JSON or base64. They are encoded as raw byte buffers:

```
Offset  Length  Type      Field Description
0       1       u8        Frame Type: 0x01 = DownloadChunk, 0x02 = UploadChunk
1       16      [u8; 16]  Transfer ID as raw 16-byte UUID (RFC 4122 v4)
17      8       u64 (BE)  Chunk index (0-indexed, Big-Endian)
25      N       [u8]      Raw payload data (N <= 32768 bytes)
```

Total frame size for a full 32 KiB chunk: `1 + 16 + 8 + 32768 = 32793 bytes`.

### 3.3 New JSON Control Envelopes (`packages/shared/src/types/files.ts`)

```typescript
// --- Pause & Resume ---

export interface FilesPauseMessage {
  transferId: string;
  direction: 'download' | 'upload';
}

export interface FilesPauseAckMessage {
  transferId: string;
  ackedChunkIndex: number;
  bytesTransferred: number;
}

export interface FilesResumeRequest {
  transferId: string;
  path: FilesPath;
  direction: 'download' | 'upload';
  fromChunkIndex: number;
}

export interface FilesResumeAckMessage {
  transferId: string;
  approved: boolean;
  fromChunkIndex: number;
  reason?: string;
}

// --- Directory Operations ---

export interface FilesMkdirRequest {
  requestId: string;
  dir: FilesPath;
  name: string;
}

export interface FilesDeleteRequest {
  requestId: string;
  path: FilesPath;
  recursive?: boolean;
}

export interface FilesRenameRequest {
  requestId: string;
  oldPath: FilesPath;
  newPath: FilesPath;
}

export interface FilesActionResult {
  requestId: string;
  action: 'mkdir' | 'delete' | 'rename';
  success: boolean;
  error?: string;
}
```

### 3.4 New Error Codes (`FilesErrorCode`)

Extending the error codes union in `packages/shared/src/types/files.ts`:
- `RESUME_INVALID`: The requested chunk offset does not match the actual `.part` file size or the file was modified.
- `DIR_NOT_EMPTY`: Attempted to delete a non-empty directory without `recursive: true`.
- `PERMISSION_DENIED`: Operation forbidden (e.g. attempting to delete sandbox root).
- `QUEUE_FULL`: Maximum number of queued items exceeded.

---

## 4. Component Details & Implementation Design

### 4.1 Agent Backend (`apps/agent/src/files.rs`)

1. **Binary Frame Parser & Serializer:**
   ```rust
   pub const BINARY_TYPE_DOWNLOAD_CHUNK: u8 = 0x01;
   pub const BINARY_TYPE_UPLOAD_CHUNK: u8 = 0x02;
   pub const BINARY_HEADER_LEN: usize = 25; // 1 + 16 + 8

   pub struct BinaryChunkFrame {
       pub frame_type: u8,
       pub transfer_id: uuid::Uuid,
       pub chunk_index: u64,
       pub data: Vec<u8>,
   }
   ```
   Decode parses slices directly without heap reallocation when reading network packets.

2. **Throughput Window Tuning:**
   - `pub const FILE_WINDOW_CHUNKS: u64 = 64;`
   - `pub const ACK_FREQUENCY_CHUNKS: u64 = 16;`
   - `pub const ACK_FLUSH_INTERVAL: Duration = Duration::from_millis(20);`

3. **Pause & Resume Handling:**
   - In `UploadState`: When receiving `files-pause`, flush `tokio::fs::File`, store final `next_chunk` in ack message, and retain `.part` on disk.
   - When receiving `files-resume`: Verify path within root. Check `.part` exists. Query metadata:
     `expected_len = from_chunk_index * FILE_CHUNK_BYTES`. If `metadata.len() == expected_len`, seek file write pointer to end and resume upload window.

4. **24-Hour Part File Janitor:**
   - Spawn a background task with `tokio::time::interval(Duration::from_secs(3600))`.
   - Traverse the sandbox root looking for files ending with `.ponter-part`.
   - If `SystemTime::now() - metadata.modified() > Duration::from_secs(86400)`, log info and remove file.

5. **Directory Management Handlers:**
   - `mkdir`: Canonicalize parent path, validate directory name component, check collision, invoke `tokio::fs::create_dir`.
   - `delete`: Resolve path. If path canonicalizes to root, return `PermissionDenied`. If directory: check if empty or `recursive == true`. Invoke `remove_file` or `remove_dir_all`.
   - `rename`: Resolve `old_path` and `new_path`. Both must be contained in root. Ensure `new_path` does not exist. Call `tokio::fs::rename`.

### 4.2 Web Client Library (`packages/file-core`)

1. **`FileClient` Enhancements:**
   - Implement binary message listener on WebRTC data channel:
     ```typescript
     dataChannel.onmessage = (event) => {
       if (typeof event.data === 'string') {
         this.handleJsonFrame(JSON.parse(event.data));
       } else if (event.data instanceof ArrayBuffer) {
         this.handleBinaryFrame(new Uint8Array(event.data));
       }
     };
     ```
   - Binary frame builder: packs UUID and `BigInt` chunk index into a pre-allocated 25-byte header buffer attached to the sliced chunk buffer.

2. **Upload Slicing (`uploadStream`):**
   ```typescript
   // Read chunk directly from File slice without loading full file into memory
   const slice = file.slice(offset, offset + FILE_CHUNK_BYTES);
   const buffer = await slice.arrayBuffer();
   dataChannel.send(packBinaryFrame(transferId, chunkIndex, buffer));
   ```

3. **Service Worker Stream Writer (`ServiceWorkerStreamWriter`):**
   - Manages communication via `MessageChannel` with `sw-files-download.js`.
   - Sends `{ type: 'CHUNK', transferId, chunk }` and `{ type: 'END', transferId }`.

### 4.3 Web UI & Pinia Store (`apps/web`)

1. **Service Worker File (`apps/web/public/sw-files-download.js`):**
   - Intercepts requests matching `/files-download-stream/:transferId/:filename`.
   - Returns a `Response` with `ReadableStream` whose controller receives chunks from the web page via `MessagePort`.

2. **Transfer Queue Store (`apps/web/src/stores/transfer-queue.ts`):**
   - Tracks all active and pending transfers:
     ```typescript
     export interface QueueItem {
       id: string;
       name: string;
       path: string;
       size: number;
       bytesTransferred: number;
       direction: 'upload' | 'download';
       status: 'queued' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
       speedBytesPerSec: number;
       etaSeconds: number | null;
       error?: string;
     }
     ```
   - Concurrency controller: Automatically dequeues next pending upload/download when active transfer settles.
   - Computes rolling average speed over 1-second intervals.

3. **`FilesView.vue` Updates:**
   - **Drag and Drop Zone:**
     - `@dragover.prevent`, `@dragenter.prevent`, `@dragleave.prevent`, `@drop.prevent` attached to directory table.
     - Visual overlay indicating drop target.
     - Extract `DataTransferItemList` and push files to `transferQueue`.
   - **Toolbar Actions:**
     - "New Folder" button: opens prompt/dialog to create directory via `files-mkdir`.
     - "Transfers" button with badge showing active/queued counts.
   - **Row Actions:**
     - Download, Rename (dialog prompt), Delete (confirmation dialog).
   - **Transfer Queue Drawer/Panel:**
     - Expandable list of transfers showing progress bar, MB/s speed, ETA, and Pause/Resume/Cancel action buttons.

---

## 5. Security & Boundary Guarantees

1. **Root Confinement Guarantee:** Every operation (`list`, `read`, `write`, `mkdir`, `delete`, `rename`) validates canonicalized paths against the configured sandbox root (`--files-root`). Symlink escapes and `..` traversal are strictly rejected.
2. **Root Immutability:** Deleting or renaming the root directory itself is rejected at both syntactic and canonicalization phases.
3. **Overwrite Prevention:** Both file uploads and file renames refuse to overwrite existing files, preventing accidental data destruction.
4. **Binary Buffer Bounds:** Binary frame parsing enforces strict packet length validation: packet length must be `>= 25` bytes and `<= 25 + 32768` bytes. Malformed packets are dropped with a warning.
5. **Service Worker Origin Isolation:** The download streaming service worker only responds to same-origin requests initiated by the authenticated user's session.

---

## 6. Verification & Test Plan

### 6.1 Unit Tests

- **`packages/file-core`:**
  - Binary framing encoding and decoding byte-for-byte fidelity.
  - Sliding window flow control with 64 chunks and cumulative acks.
  - Chunk slicing validation (ensuring memory does not hold entire file).
  - Pause and resume state transitions and offset continuity.
- **`apps/agent` (`files.rs`):**
  - Binary frame parsing and validation against malformed lengths.
  - Throughput window calculations and ack flushing.
  - `mkdir`, `delete`, `rename` sandbox validation and error paths.
  - Janitor task: verify deletion of `.part` files older than 24 hours while preserving fresh ones.
- **`apps/web`:**
  - Queue store state transitions (queued -> active -> paused/completed).
  - Drag and drop event handling and file dispatch.
  - Dialog component tests for New Folder, Rename, and Delete confirmations.

### 6.2 E2E Tests (`packages/webrtc-core/test/e2e/files-advanced.e2e.test.ts`)

1. **High-Speed Transfer Test:** Transfer a 50 MB test file and assert transfer throughput exceeds 10 MB/s.
2. **Binary Frame Integrity Test:** Verify file checksum (SHA-256) matches exactly across upload and download.
3. **Pause & Resume Upload Test:** Start a 20 MB upload, pause at ~5 MB, resume, and verify completion and file integrity on disk.
4. **Pause & Resume Download Test:** Start a 20 MB download, pause, resume, and verify downloaded bytes match original.
5. **Directory Management Suite:** Create a subfolder, rename a file within it, attempt invalid escape renaming, and delete the subfolder.
6. **Queue Concurrency Test:** Enqueue 3 uploads simultaneously; verify that exactly 1 is active while 2 remain queued, processing in FIFO order.

---

## 7. Acceptance Criteria

1. **Throughput Criterion:** A 50 MB file transfer over local WebRTC DataChannel achieves sustained throughput > 10 MB/s.
2. **Binary Framing Criterion:** Chunks are transmitted as binary frames (0x01/0x02) without Base64 encoding.
3. **Streaming & Memory Criterion:** Web client tab memory usage remains under 50 MB during a 500 MB file upload and download.
4. **Queue & Drag-and-Drop Criterion:** Users can drag and drop multiple files; files queue and upload sequentially with visible progress, speed, and ETA.
5. **Pause & Resume Criterion:** Pausing an in-flight transfer halts network frames and leaves `.part` file intact; resuming continues from the paused chunk index without restarting.
6. **File Operations Criterion:** Users can create directories, rename files/directories, and delete files/directories within the sandbox root via UI.
7. **CI & Regressions:** All existing terminal, desktop, and Week 10 file tests continue to pass; `cargo test` and `pnpm test` pass across the workspace.

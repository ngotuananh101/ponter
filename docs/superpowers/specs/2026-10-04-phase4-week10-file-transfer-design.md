# Phase 4 Week 10 — File Transfer (Thin Slice, Two-Way) Design Specification

**Status:** Draft — Ready for review
**Date:** 2026-10-04
**Author:** Ngo Tuan Anh & Claude
**Target:** Phase 4 Week 10 of `docs/ARCHITECTURE.md` (`:1003`, "Phase 4: File Transfer (Weeks 10-11)"). Week 10 delivers the **thin slice**: a third session mode that lists a sandboxed directory, downloads files, and uploads files — **both directions**, over one `files` data channel — behind an agent-local gate (ADR-32). Week 11 (large files, streaming to disk, hardening) is explicitly out of scope.

---

## 1. Overview & Objectives

Phase 3 ended with two session modes: `terminal` (a PTY over a `terminal` channel) and `desktop` (a media track plus a `control` channel). Phase 4 turns Ponter into a remote file manager (`ARCHITECTURE.md:26`, "Remote File Manager with high-speed transfer"). Week 10 ships the **wire, the sandbox, the two directions, and the tests** — not the performance work and not the security workstreams.

One constraint shapes the whole design:

- **File transfer is the first session that reads and writes the agent host's filesystem on behalf of the peer, and the peer is unverified.** The E2EE audit's **H3** (`docs/security/2026-10-01-e2ee-zero-trust-audit.md:163`) finds the agent has no peer identity verification: it approves a session from the offer's attacker-controlled capability strings (`apps/agent/src/main.rs:377-385`). The audit's **H11** (`:270`) names this feature by name: *"DataChannel traffic (terminal, input, future file transfer) is protected only by WebRTC's default DTLS/SCTP layer"*. So Week 10 ships a **gated, sandboxed** mechanism: the agent serves files only when the operator configured a root locally (a flag a remote peer cannot set), refuses the whole offer otherwise (ADR-32), and confines every wire path to that root (ADR-33). Usable, unverified-peer file access waits for WS1/WS2/WS3 (Phase 5), exactly as Week 9's input gate did.

### 1.1 Core Goals

1. **A third session mode, `Files`, with its own channel label `files`.** `classify_offer` gains one branch (terminal → desktop → files, exact string match, pure and total), and the session accepts exactly one inbound channel labeled `files` (ADR-31). No new WebRTC machinery: `PeerConnection` pre-creates channels from `channelLabels` (`packages/webrtc-core/src/connection.ts:132-138`) and `packages/webrtc-core/test/p2p.test.ts:262` already exercises a `files` label.
2. **Two-way transfer over JSON envelopes on that channel.** Browser→agent: `files-list`, `files-download`, `files-upload-begin`, `files-upload-chunk`, `files-upload-end`, `files-cancel`, `files-download-ack`. Agent→browser: `files-list-result`, `files-download-begin`, `files-download-chunk`, `files-download-end`, `files-upload-ack`, `files-upload-complete`, `files-error` (§2.2).
3. **A sandbox with one root.** The operator passes `--files-root <path>` (env `AGENT_FILES_ROOT`). Every wire path is POSIX-relative to that root; absolute paths, `.`/`..` components, and anything canonicalizing outside the root are rejected (ADR-33). Uploads write `{name}.ponter-part` and rename on completion — atomic, no overwrite.
4. **A gate that refuses at the offer.** With no `--files-root` (or a root that is missing, not a directory, or unreadable), a `files` offer is answered `approved: false` and the peer is closed — never a session that cannot serve a frame (ADR-32).
5. **A new package, `packages/file-core`,** exposing a `FileClient` that mirrors `packages/terminal-core`'s shape: `constructor(agentId, dataChannelManager)`, subscribes to the `files` channel, owns no peer (ADR-31, §5.2).
6. **A minimal web surface.** A third tab kind `files` with `FilesView.vue` (breadcrumb, directory table, download on click, upload into the current directory, progress + cancel, error banner), gated on the agent's `files` capability, respecting the existing one-session-per-agent rule (ADR-14). The server is untouched (ADR-35).

### 1.2 Non-Goals (Explicitly Deferred)

- **Application-layer E2EE for file bytes.** Files cross the wire under DTLS only — the audit's **M7** (`:340`) and **M8** (`:349`), and H11 (`:270`) names this transfer explicitly. Closing it is **WS1** (Phase 5), not Week 10. §9 states it rather than hiding it.
- **Peer identity and consent (H2/H3).** The gate is a holding pattern, not a fix (ADR-32). WS2/WS3 remain open.
- **Resumable transfers, parallel chunk streams, compression, delta sync.** One transfer per direction at a time, sequential chunks, no resume (a cancel is a cancel).
- **Directory upload, recursive delete, rename, move, mkdir.** List/download/upload only.
- **Drag-and-drop and multi-select.** One file per upload action.
- **Server-side transfer records.** The `FileTransfer` row type in `packages/shared/src/types/files.ts:15-27` stays declared-but-unused; there is no persistence, no history endpoint, and no schema change (ADR-35).
- **Streaming large files to disk in the browser.** Week 10 downloads into memory (Blob) and uploads from memory (`File.arrayBuffer()`); the 1 GiB agent-side cap (§2.5) is not a browser-memory promise. Streaming to disk (File System Access API, chunked `File` reads) is Week 11 — recorded as a watch item (§9.4).
- **The >10MB/s performance target** (`ARCHITECTURE.md:1147`, "Parallel chunks"). Week 10 is a single sequential stream; throughput is measured **informally** in the manual demo and is **not** an acceptance criterion (§10.2) — same precedent as the Week 8 glass-to-glass latency note.
- **Windows/macOS runtime filesystem behavior verification.** Those targets must compile and pass unit tests; runtime behavior (path separators, `canonicalize` output, case sensitivity) is unverified — no CI hardware (§3.7).
- **Interaction between file transfer and the input gate.** Files sessions carry no `desktop-input` frames; a `files` session never injects.

---

## 2. Wire Protocol & Contract Specifications

### 2.1 The `files` channel and the third session mode

An offer selects a mode by its capability strings (`apps/agent/src/main.rs:377-385`). Week 10 appends one branch **after** terminal and desktop, so a malformed client offering several capabilities keeps the established precedence:

| Flow | `channelLabels` | `capabilities` | `media` | Agent accepts label |
|---|---|---|---|---|
| Terminal (existing) | `['terminal']` | omitted → falls back to `channelLabels` | omitted | `terminal` |
| Desktop (existing) | `['control']` | `['desktop']` | `{ video: true }` | `control` |
| Files (Week 10) | `['files']` | `['files']` | omitted | `files` |

- `classify_offer` order: **terminal → desktop → files** (`main.rs:377-385`); `['files','desktop']` classifies as Desktop, `['files']` as Files, `['files','terminal']` as Terminal.
- The session accepts **exactly one** inbound data channel, labeled `files`; a second channel is refused by the existing `SessionHandler` logic (`apps/agent/src/rtc.rs:625-651`). ADR-09's exact-label rule is unchanged.
- The agent's files branch uses `build_peer(..., media_only: false, has_control: false)` (`rtc.rs:367-482`): a files session is a data-channel session like the terminal, so it keeps the RFC-shaped ICE defaults and registers no congestion-control target.

### 2.2 Frames (JSON `DataChannelMessage<T>` envelopes)

All frames use the existing envelope (`packages/shared/src/types/webrtc.ts:9-14`): `{ type, channel: 'files', payload, timestamp }`. Unknown `type` values on the `files` channel are **ignored with a warn** (forward compatibility), never fatal.

**Browser → agent**

| `type` | `payload` | Purpose |
|---|---|---|
| `files-list` | `FilesListRequest` | List a directory (`path: ''` = root) |
| `files-download` | `FilesDownloadRequest` | Start downloading one file |
| `files-upload-begin` | `FilesUploadBeginRequest` | Announce an upload (target dir + name + size) |
| `files-upload-chunk` | `FileChunkMessage` | One upload chunk (base64) |
| `files-upload-end` | `FilesUploadEndRequest` | All chunks sent; finalize (fsync + rename) |
| `files-cancel` | `FilesCancelMessage` | Abort a transfer or a pending list |
| `files-download-ack` | `FilesAckMessage` | Download flow control: contiguous count received |

**Agent → browser**

| `type` | `payload` | Purpose |
|---|---|---|
| `files-list-result` | `FilesListResult` | Directory entries (possibly truncated) |
| `files-download-begin` | `FilesDownloadBegin` | Download accepted: name, size, totalChunks |
| `files-download-chunk` | `FileChunkMessage` | One download chunk (base64) |
| `files-download-end` | `FilesDownloadEnd` | All chunks sent |
| `files-upload-ack` | `FilesAckMessage` | Upload flow control: contiguous count received |
| `files-upload-complete` | `FilesUploadComplete` | Upload finalized on disk |
| `files-error` | `FilesErrorMessage` | Any failure (see §2.6) |

The chunk payload is the **existing** `FileChunkMessage` (`packages/shared/src/types/files.ts:29-34`) in **both** directions — one shape, one codec.

### 2.3 Payload shapes (extending `packages/shared/src/types/files.ts`)

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
  truncated: boolean;    // true when the directory exceeded MAX_LIST_ENTRIES
}

export interface FilesDownloadRequest {
  transferId: string;
  path: FilesPath;       // must name a file
}

export interface FilesDownloadBegin {
  transferId: string;
  name: string;          // basename
  path: FilesPath;
  size: number;          // bytes
  totalChunks: number;   // ceil(size / FILE_CHUNK_BYTES); 0 for an empty file
}

export interface FilesDownloadEnd {
  transferId: string;
}

export interface FilesUploadBeginRequest {
  transferId: string;
  path: FilesPath;       // target DIRECTORY ('' = root); must exist
  name: string;          // single path component; target = path + '/' + name
  size: number;          // bytes, declared by the browser
}

export interface FilesUploadEndRequest {
  transferId: string;
}

export interface FilesUploadComplete {
  transferId: string;
  name: string;
  path: FilesPath;       // full relative path of the written file
  size: number;
}

/** Cumulative flow-control ack, used in both directions. */
export interface FilesAckMessage {
  transferId: string;
  /** Count of CONTIGUOUS chunks received so far (0 before the first chunk). */
  nextChunkIndex: number;
}

export interface FilesCancelMessage {
  requestId?: string;    // cancel a pending list
  transferId?: string;   // cancel a transfer
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
  requestId?: string;    // set when the failure answers a list request
  transferId?: string;   // set when the failure belongs to a transfer
  code: FilesErrorCode;
  message: string;       // human-readable, never parsed
}
```

`TransferDirection`, `FileTransferStatus`, `FileTransfer`, and `FileChunkMessage` already exist (`files.ts:1-34`) and stay as they are; `FileTransfer`/`FileTransferStatus` remain unused by design (§1.2). `RemoteFile.mode` stays optional and is **not** populated in Week 10 (Unix-only metadata, YAGNI); `RemoteFile.modifiedAt` is an RFC 3339 UTC string.

### 2.4 Flow control (windowed, explicit acks)

- **Window: 16 chunks in flight.** The sender may have at most 16 un-acked chunks on the wire; the receiver sends an ack after each chunk it accepts. At 32 KiB per chunk that bounds in-flight data at 512 KiB per direction, 1 MiB per session (one download + one upload may run concurrently).
- **Ack semantics (both directions).** `nextChunkIndex` is the **count of contiguously received chunks** — a cumulative index, not a delta. Duplicate or regressive acks (`nextChunkIndex <= current acked`) are ignored; an ack beyond what was sent (`nextChunkIndex > sent`) is a protocol violation → `files-error` `BAD_FRAME`, transfer failed and cleaned up. The sender may send while `sent - acked < 16` and `sent < totalChunks`.
- **Ordering.** The channel is created `{ ordered: true }` (`connection.ts:132-138`), so chunks arrive in order; the ack scheme therefore doubles as the receiver's validation that no chunk was lost. A receiver that sees `chunkIndex != nextExpected` fails the transfer with `BAD_FRAME` (hostile or broken peer — do not guess).
- **Chunk-length validation (receiver, both directions).** Every chunk except the last must decode to exactly 32768 bytes; the last must decode to `size − (totalChunks−1) × 32768`. A mismatch → `BAD_FRAME`, transfer failed and cleaned up. The receiver derives the expected `totalChunks` from the declared/stat `size` (§2.5); a chunk frame whose own `totalChunks` disagrees with that derivation → `BAD_FRAME` (one source of truth, never the frame's claim). This makes the sender's declared `size` **structurally exact** — a hostile peer cannot smuggle extra bytes past the declared cap by padding a chunk, and the final file length is determined by the protocol, not by accumulated trust.
- **Idle timeout: 30 s.** Each side fails a transfer that makes no progress (no chunk and no ack) for 30 s: the agent sends `files-error` `TRANSFER_TIMEOUT` and cleans up (`.part` removed); the client rejects the handle with `TRANSFER_TIMEOUT` and sends `files-cancel`.
- **Concurrency: one transfer per direction.** A second `files-download` while a download runs (or `files-upload-begin` while an upload runs) → `files-error` `TRANSFER_BUSY` with the offending id. One download **and** one upload may run concurrently (§2.4 window budget above).
- **Explicit acks, not `bufferedAmount`.** The Rust agent's sans-IO WebRTC stack (`webrtc` 0.21) does not give a portable, trustworthy `bufferedAmount`; the browser's value is not visible to the agent at all. The explicit-ack scheme works **identically in both directions** and is directly testable (§5.3, §8). ADR-34 records this.

### 2.5 Size, chunk, and cap arithmetic

Two shared constants, one on each side of the wire, pinned by tests (§6.4, §5.3): `FILE_CHUNK_BYTES = 32768` (raw bytes per chunk, agent `files.rs` and `packages/file-core/src/transfer.ts`) and `FILE_MAX_BYTES = 1 << 30` (the 1 GiB cap).

- **Chunk: 32 KiB raw → base64.** 32 768 bytes become 43 692 base64 characters (≈ 43.7 KB); with the `FileChunkMessage` JSON envelope the framed message is ≈ 43.8 KB — comfortably under `MAX_FRAME_BYTES = 64 KiB` (`apps/agent/src/pty.rs:26`), the inbound guard checked **before** `serde_json` parses. The same constant bounds upload chunk frames in the other direction.
- **File cap: 1 GiB.** A download whose size exceeds it → `FILE_TOO_LARGE`; an upload whose declared `size` exceeds it → `FILE_TOO_LARGE` (rejected at `files-upload-begin`, before any chunk). Enforced on the **declared/stat** size; the chunk-length rule (§2.4) makes that declared size structurally exact, so no separate running byte counter is needed.
- **List cap: 4096 entries.** A directory with more entries returns the first 4096 (deterministic order: directories first, then name, byte-wise ascending) with `truncated: true`. The browser shows a "truncated" note.
- **Empty files.** `totalChunks = ceil(size / 32768)` with `ceil(0) = 0`: a download sends `files-download-begin` (`totalChunks: 0`) then `files-download-end` immediately; an upload sends `files-upload-begin` (`size: 0`) then `files-upload-end` immediately, and the agent finalizes an empty file.
- **IDs.** `transferId` and `requestId` are UUID v4 minted by the **browser** (`crypto.randomUUID`), one per request/transfer; the agent echoes them and never mints ids. The agent keys all state by them.

### 2.6 Error semantics

- Every `files-error` carries a `code` from the enum in §2.3 and, when attributable, the `requestId`/`transferId` of the request or transfer. `message` is for humans only.
- **Order of checks** (so one input maps to exactly one code): decode guard → syntactic path validation (`INVALID_PATH`) → canonicalize + root-prefix check (`PATH_OUTSIDE_ROOT`) → existence/type (`NOT_FOUND`, `NOT_A_FILE`, `NOT_A_DIRECTORY`) → caps (`FILE_TOO_LARGE`) → busy (`TRANSFER_BUSY`). For uploads the target must **not** exist: `FILE_EXISTS`. Everything else from the filesystem is `IO_ERROR`.
- **Fail-soft.** No `files-error`, decode failure, or I/O failure ever ends the session; the channel and the other direction keep running. Only the offending transfer/request fails.
- **Malformed frames.** A frame whose JSON parses but whose payload fails validation → `files-error` `BAD_FRAME` (with the id, when extractable) and the transfer fails; a frame that cannot be parsed at all (including oversize, caught before parsing) is logged and dropped.
- **Unknown ids.** A chunk or ack for an unknown `transferId` → `files-error` `TRANSFER_UNKNOWN`, frame ignored. A `files-cancel` for an unknown id is **idempotent** (log only, no error frame — the transfer may have just completed).
- **Disconnect.** On channel close or peer failure the agent cancels both active transfers, removes any `.part` file, and logs; the browser marks open transfers cancelled (client code `'CANCELLED'`, §5.2).

---

## 3. Verified Findings

Every claim below was re-verified against the working tree on 2026-10-04. One cite in the task brief had drifted and is corrected here (§3.6).

### 3.1 The shared types already anticipate this feature (but are unused)

- `packages/shared/src/types/webrtc.ts:7` — `WebRTCChannelType` already includes `'files'`: `'terminal' | 'desktop' | 'files' | 'control'`. No type change needed for the label.
- `packages/shared/src/types/files.ts:1-34` — five types exist: `TransferDirection` (`:1`), `FileTransferStatus` (`:3-4`), `RemoteFile` (`:6-13`), `FileTransfer` (`:15-27`), `FileChunkMessage` (`:29-34`, `{ transferId, chunkIndex, totalChunks, data }` with `data` base64). A workspace-wide grep finds them **only** re-exported at `packages/shared/src/types/index.ts:29-35` — no producer, no consumer. Week 10 is the first user; §2.3 extends the module in place.
- `packages/shared/src/types/terminal.ts:16-31` — the frame-payload convention Week 10 mirrors: small interfaces, camelCase, ids in the payload.

### 3.2 The WebRTC layer already supports an arbitrary channel label

- `packages/webrtc-core/src/data-channel.ts` — `registerChannel` `:19`, `getChannel` `:58`, `hasChannel` `:62`, `sendJson` `:74-88` (throws `Data channel "<label>" is not registered` at `:75-77`), `onMessage` `:107`, `onStateChange` `:124`. Label-keyed maps; nothing terminal- or desktop-specific.
- `packages/webrtc-core/src/connection.ts` — incoming channels are auto-registered `:111-113`; the offerer pre-creates every `channelLabels` entry `{ ordered: true }` `:132-138`; `refusalReason` field `:78`; the answer branch checks the refusal flag `:294-297` and throws a **hardcoded** message: `'the agent refused the connection (one session per agent; another session is already active)'`; `waitForChannel` throws `refusalReason` at `:206-207`. **Design consequence:** a Week 10 gate refusal (`approved: false`, ADR-32) surfaces through that exact wording. Week 10 deliberately does **not** change `webrtc-core` (the owner-approved design keeps it untouched), so the spec records this as a known UI-wording limitation (§7.4, §9.1).
- `packages/webrtc-core/test/p2p.test.ts:262` — an existing test already opens `channelLabels: ['desktop', 'files']` and asserts both channels open: precedent that `files` needs no library change.

### 3.3 The agent's session plumbing is a clean insertion point

- `apps/agent/src/main.rs:366-370` — `enum SessionMode { Terminal, Desktop, None }`; `:377-385` — `classify_offer`, pure/total, exact `==` comparison, terminal checked first (unit test `:1979-1996`).
- `:393-418` — `SessionConfig` (owned, `Clone`) with musl-`#[allow(dead_code)]` fields; populated once at `:471`. `:728-731` — `accepted_label` selects the one label per session (`Desktop → CONTROL_LABEL`, else `TERMINAL_LABEL`). `:760-786` — mode dispatch: Desktop → `run_desktop_session`, None → `rtc::refuse_offer` + `peer.close()`, Terminal falls through to `answer_offer` (`:788`).
- `:105-113` — the CLI gate pattern to mirror: `#[arg(long, env = "AGENT_ALLOW_INPUT", value_parser = BoolishValueParser::new(), num_args = 0..=1, default_missing_value = "true", default_value_t = false)] allow_input: bool`; its unit test `:2199-2251`.
- `:1153-1171` — the desktop refusal pattern: on a pre-answer failure, `tracing::warn!(...)` + `rtc::refuse_offer(...)` + `peer.close()` + `Ok(())`. Week 10's gate refusal is the same shape, at the same point (after `build_peer`, before the answer).
- `apps/agent/src/rtc.rs:55-62` — label constants (`TERMINAL_LABEL :56`, `CONTROL_LABEL :59`, `DESKTOP_LABEL :62`, ADR-09 comment `:55`). `:224-237` — `send_desktop_answer` (a mode-specific approved answer). `:707-724` — `answer_offer` is **terminal-only**: `let approved = offer.capabilities.iter().any(|c| c == TERMINAL_LABEL);` (`:722`). `:731-737` — `refuse_offer`. `:745-770` — shared `send_answer(peer, offer, approved, outbound)`. `:367-482` — `build_peer(pushed, stun, handler, media_only, has_control)`; `:625-651` — `on_data_channel` accepts exactly one label, refuses a second. **Design consequence:** Files needs its own approved-answer path; Week 10 generalizes `send_desktop_answer`'s body into a shared `send_approved_answer` used by both (`send_desktop_answer` keeps its name and delegates) — the smallest change that keeps `answer_offer`'s terminal semantics intact (§6.2).
- `apps/agent/src/pty.rs:22` — `MAX_PTY_CHUNK = 16 * 1024` (with the base64/frame-size comment `:19-21`); `:26` — `MAX_FRAME_BYTES = 64 * 1024` (checked before parsing); `:38-45` — the Rust `DataChannelMessage<T>` envelope (`#[serde(rename_all = "camelCase")]`); `:53-66` — `PtyErrorCode` + `as_str()` pinning wire spellings; `:124-144` — `decode_pty_input` (size check before serde, strict channel/type, `Ok(None)` for non-match). Week 10's decoder mirrors this guard shape exactly.
- `apps/agent/Cargo.toml:21` — tokio with `features = ["full"]`, so `tokio::fs` is available with no new dependency; `:40-54` — the musl-gated desktop dependency block that `files.rs` must **not** join (§6.1).

### 3.4 The server is mode-agnostic today

- `apps/server/src/routes/sessions.ts:48-97` — `POST /api/sessions` accepts `{ deviceId?, agentId? }` and inserts `{ userId, deviceId, agentId, status: 'pending' }`; nothing reads capabilities or modes.
- `apps/server/src/db/schema.ts:63-87` — the `sessions` table has no mode column. The mode lives in the offer's `capabilities`, which the server relays as SDP payload (`routes/signal.ts:82, :113` stores the answer's `approved: body.approved !== false` — recorded, not enforced; that is audit finding **H2**, `:149`).
- **Design consequence (ADR-35):** Week 10 adds no server change — no column, no endpoint, no migration.

### 3.5 The web layer is where the third kind must be threaded

- `apps/web/src/stores/terminal.ts` — `TabItem.kind: 'terminal' | 'desktop'` (`:28`); `desktopConnections` map `:99-107`; `setInitStep(agentId, kind: 'terminal' | 'desktop', step)` `:129-131`; `openTab`'s exclusivity guard `:305-313`; `openDesktopTab` `:497-682` (exclusivity `:503-511` — refuses when the agent has **any** tab; tab pushed before the handshake; `new PeerConnection(..., { role: 'offerer', channelLabels: ['control'], capabilities: ['desktop'], media: { video: true } })` `:543-548`; orphan-release check `:598-605`; `retryTab` `:691-724`; `closeTab` dispatches on `kind === 'desktop'` `:789-811`). `openFilesTab` mirrors this lifecycle (§7.2).
- `apps/web/src/lib/connection-steps.ts` — `InitStep = 'session' | 'ice' | 'negotiating' | 'shell' | 'stream'` (`:7`); `INIT_STEPS: Record<'terminal' | 'desktop', InitStepDef[]>` (`:19-31`); `stepIndex(kind: 'terminal' | 'desktop', step)` (`:34-40`). `ConnectionProgress.vue` consumes `INIT_STEPS[props.tab.kind]` (`:9`) and `stepIndex(props.tab.kind, ...)` (`:15-20`), so extending the unions to `'files'` is what makes the overlay work for the new kind.
- `apps/web/src/views/WorkspaceView.vue` — `XtermTerminal` when `kind === 'terminal' && session` (`:192-199`), `DesktopView v-else-if kind === 'desktop'` (`:200-204`), `ConnectionProgress` for terminal only (`:212-218`), error overlay for terminal only (`:223-248`). A `FilesView` branch and a widened progress condition are needed (§7.1).
- `apps/web/src/components/terminal/WorkspaceSidebar.vue` — emits `connectAgent`/`connectDesktop` (`:11-14`); terminal button always (`:142-150`); desktop button `v-if="a.capabilities.includes('desktop')"` (`:151-160`) — the Files button mirrors this exactly (§7.3).
- `apps/web/src/components/terminal/TerminalTabBar.vue` — `kind: 'terminal' | 'desktop'` prop (`:11`); icon branch `Monitor` if desktop else `Terminal` (`:64-68`) — gains a `files` branch (§7.3).
- `apps/web/src/components/agent/RegisterAgentDialog.vue:95` — `capabilities: ['terminal', 'desktop']` hardcoded in `apiClient.agents.create`; gains `'files'`.
- `apps/web/src/components/agent/EditAgentDialog.vue` — `TOGGLEABLE_CAPABILITIES = ['terminal', 'desktop'] as const` at **`:33`** (the task brief said `:31`; the file has drifted two lines — corrected here); extras preservation `:79-91` (the comment at `:79-80` already names a future `'files'` capability); two capability toggle buttons `:229-265`. Gains a `'files'` toggle.
- `apps/web/src/components/terminal/ConnectionProgress.vue` — no change beyond the union extension (§7.2).
- `apps/web/src/__tests__/terminal-store.test.ts` — the mocking pattern to mirror: `vi.mock('@ponter/file-core', ...)` with a constructor function and module-level spies.

### 3.6 Test infrastructure: what already exists, what drifted

- `packages/webrtc-core/test/e2e/harness.ts` — `seed({ capabilities = ['terminal'] })` `:369-415` returns `{ token, agentId, credential, sessionId }` (already parameterizes capabilities, so a files suite needs no harness change); `spawnAgent(agentId, credential, extraArgs = [], env = {})` `:417-443` already takes extra args and env; `frameBytes` `:478-483`; `openTerminalPeer` `:543-575` (the peer-open pattern to mirror as `openFilesPeer`); `connectTerminal` `:577-588`; `waitForAgentOnline` `:445-476`.
- `packages/webrtc-core/vitest.e2e.config.ts` — includes `test/e2e/**/*.e2e.test.ts`, `fileParallelism: false`, `sequence.concurrent: false`, 120 s test timeout. `terminal.e2e.test.ts` needs no Xvfb; the files suite follows it.
- `.github/workflows/ci-e2e.yml` — job **"Cross-language terminal E2E"** (`:36`) with path filters `packages/webrtc-core/**`, `packages/shared/**`, `apps/agent/**`, `apps/server/**` (`:13-28`); runs `pnpm --filter @ponter/webrtc-core test:e2e` (`:80`). The new suite lives under `packages/webrtc-core/test/e2e/`, so it runs there with **no workflow change**. **Recorded gap:** a future PR touching **only** `packages/file-core/**` would not trigger this job (that path is not in the filters) — its unit tests still run in the Node CI job; the gap is noted in §8.5 rather than silently patched, because the owner-approved design says no workflow changes.
- **Drift found and corrected in this spec:** `EditAgentDialog.vue`'s `TOGGLEABLE_CAPABILITIES` is at `:33`, not `:31` (§3.5 records the corrected cite). No other cite in the task brief had drifted.

### 3.7 What cannot be verified from this repository

- **Windows/macOS runtime filesystem behavior.** The path sandbox (canonicalize + prefix check) is implemented against `std::fs`/`tokio::fs`; on Windows `canonicalize` returns `\\?\`-prefixed paths and on macOS the filesystem is case-insensitive. The Linux E2E proves the policy shape, not those platforms. Compile + unit tests only, as Week 7/8/9 left capture/injection runtime unverified.
- **Real-network throughput.** No network path exists in CI (loopback only). The >10MB/s target is measured informally (§8.4) and is not an AC.
- **Chromium's actual `maxMessageSize` enforcement.** The 64 KiB figure is the agent's documented guard (`pty.rs:19-26`); Week 10 verifies the arithmetic (≈ 43.7 KB < 64 KiB) and that frames transit, not the browser's internal limit.
- **DTLS-only confidentiality as a tested property.** It is a protocol fact recorded by the audit (H11 `:270`), not something a repository test asserts; §9 states it.
- **Browser memory behavior for large files.** The thin-slice UI loads whole files into memory; actual RAM ceilings per browser are not measured here (watch item, §9.4).

---

## 4. Architectural Decision Records

### ADR-31: Files is a third session mode with its own channel label

**Context.** Phase 3 established one session per agent (ADR-14) and one accepted channel label per session (ADR-09). File transfer could have been smuggled onto an existing channel — the `control` channel is idle in a files-only session, and `desktop`/`terminal` sessions could theoretically multiplex `files-*` frames. It could also have reused the `desktop` capability label and switched on frame type.

**Decision.** File transfer is a **third `SessionMode::Files`**, classified from the offer's exact capability string `'files'` (`classify_offer` order: terminal → desktop → files, `apps/agent/src/main.rs:377-385`), served over **one** channel labeled `'files'` (`channelLabels: ['files']`, `capabilities: ['files']`, no media track). The label already exists in `WebRTCChannelType` (`packages/shared/src/types/webrtc.ts:7`) and is already exercised by `p2p.test.ts:262`. The session accepts exactly one inbound channel — the existing `SessionHandler` single-channel rule (`rtc.rs:625-651`) applies unchanged.

**Rationale.** (a) The exclusivity rule (ADR-14) means a files session is *the* session for that agent while open — so it needs no channel sharing with terminal/desktop semantics; (b) a dedicated label makes the agent's authorization boundary the same as the mode boundary: one label, one dispatcher, one gate (ADR-32); (c) reusing `control` would couple file semantics to a channel whose lifetime is defined by the desktop stream, and reusing the `desktop` capability would make the mode invisible in the offer. The `None`-mode refusal for unrecognized capabilities (`main.rs:779-784`) keeps an old agent refusing a `files` offer cleanly (approved:false) instead of half-negotiating.

**Consequence.** A files session uses `build_peer(media_only: false, has_control: false)` (`rtc.rs:367-482`) — the terminal-shaped data-channel configuration, RFC ICE defaults, no ABR target. `SessionMode`, `accepted_label` (`main.rs:728-731`), and the dispatch match (`:760-786`) each gain one arm. No new WebRTC or server machinery (ADR-35).

### ADR-32: The files gate refuses the whole offer, not per-frame

**Context.** Week 9's input gate (ADR-29) **drops individual frames** when closed, because input rides a session that must keep running (the stream). Files has the same trust problem — H3 (`:163`), unverified peer — but a different session shape: with no configured root, **every** frame the client could send would be refused, and a session whose entire purpose is unreachable is worse than no session: it burns the ADR-14 slot, produces confusing mid-transfer errors, and teaches the UI that the agent "supports files" when it does not. Two options were weighed:

- **(a) Drop-frames gate** (Week 9's shape): approve the offer, serve nothing, answer each frame with `files-error` — rejected: an approved session that can never do anything misleads both the browser and the user, and it makes "the agent supports files" indistinguishable from "the agent is misconfigured" on the wire.
- **(b) Refuse-at-offer gate:** with no root, the agent answers the files offer `approved: false` and closes — chosen.

**Decision.** The agent resolves `--files-root` (env `AGENT_FILES_ROOT`) per offer from `SessionConfig`. A `Files` offer is refused **before any answer is sent** if the root is unset, missing, not a directory, or unreadable: `tracing::warn!`, `rtc::refuse_offer`, `peer.close()`, `Ok(())` — the same shape as the desktop capture-failure refusals (`main.rs:1153-1171`) and the `None`-mode refusal (`:779-784`). The refusal is evaluated **per offer**, not once at startup, so a root that becomes readable later (or a re-created mount) is picked up without restarting the agent; the gate is "the operator pointed the agent at a real directory", checked at the moment it matters.

**Rationale.** Refuse-at-offer is the honest signal: the browser learns "this agent will not serve files" in the SDP answer, at the exact moment a session is attempted — not through per-frame errors after a misleading success. It also shrinks the attack surface: a refused offer never reaches `files.rs`, so there is no session state to attack. The difference from ADR-29 is justified by the difference in the served thing: input was a rider on a live stream that must not die; files **is** the session, so refusing the session is the natural granularity.

**Consequence.** The `approved: false` path is already handled end-to-end (server records it, `connection.ts:294-297` rejects, `waitForChannel` fails fast) — with one recorded limitation: the hardcoded client-side message says "one session per agent" (a different refusal reason), so a gate refusal surfaces with misleading wording until `webrtc-core`'s message is generalized (out of scope this week; §7.4, §9.1). A gate refusal is also indistinguishable from an ADR-14 refusal to the browser. Both are recorded, not hidden. The gate is a **policy** gate like ADR-29: the shipped binary contains the file code and serves files when the flag is set.

### ADR-33: Sandbox = one canonicalized root + prefix check; POSIX-relative wire paths; uploads via `.part` + atomic rename

**Context.** Every request carries a path chosen by the peer. The agent must turn that string into a file operation that can never leave the operator-chosen directory, on any OS, without trusting the client's normalization. It must also write uploads without exposing half-written files and without silently destroying existing data.

**Decision.** Three rules, all agent-side:

1. **Wire paths are POSIX-relative to the root** (`''` = root; `a/b/c` uses `/` on every OS). The agent rejects: absolute paths, empty components, `.` and `..` components, and any component containing a NUL. It then **canonicalizes** the resolved path (`tokio::fs::canonicalize`, which resolves symlinks) and requires the result to equal the canonicalized root or start with `root + separator` — a **prefix check on the canonical form**, which defeats `..`, symlink escape, and the prefix-confusion trap (`/srv/files` vs `/srv/files2`) in one step. For a **non-existent** target (the upload case), the agent canonicalizes the **parent directory** and validates the file **name** as a single safe component (no separators, not `.`/`..`), because canonicalizing the target itself is impossible before it exists.
2. **Uploads write to a sibling `{name}.ponter-part`** in the target directory. Chunks append to that file; on `files-upload-end` the agent flushes, `fsync`s the file, and `rename`s it to the final name — atomic on POSIX; on Windows `rename` over an existing file fails, which is consistent with rule 3. On `files-cancel`, error, or disconnect, the `.part` file is removed. The final name must **not** exist: an upload whose target exists → `FILE_EXISTS` at `files-upload-begin` (fail before any bytes).
3. **No overwrite, ever, in Week 10.** `FILE_EXISTS` for upload targets and for the rename step (defense in depth against a race between the begin-check and the rename: the rename is attempted without replace; a racing creator loses the race → `FILE_EXISTS`, `.part` cleaned).

**Rationale.** Canonicalize-then-prefix-check is the one policy that handles all escape routes uniformly — it is enforced by the filesystem's own resolution, not by string arithmetic the peer might outsmart. POSIX-relative wire paths keep the protocol identical on every OS and keep the browser free of OS path logic. `.part` + rename is the standard atomic-write shape; without it a disconnect mid-upload leaves a truncated file indistinguishable from a complete one. Refusing overwrite is the conservative default for a feature whose peer is not yet verified (H3): destroying data is not something a thin slice should be able to do by accident or attack.

**Consequence.** `canonicalize` is inherently TOCTOU-adjacent (a symlink swapped between check and use); the agent re-checks the **parent** immediately before the upload's first write, and the `.part`/rename discipline bounds the damage of a race to the target directory the operator already exposed. The tests pin the trap cases: `..`, absolute, symlink-escape, and `root` vs `root2` prefix confusion (§8.1). On Windows, canonicalized paths are `\\?\`-prefixed — both sides of the prefix check are canonicalized, so the comparison stays valid; runtime behavior on Windows/macOS remains unverified (§3.7).

### ADR-34: 32 KiB chunks + base64 under the 64 KiB frame cap; windowed flow control with explicit acks

**Context.** The agent's inbound guard is `MAX_FRAME_BYTES = 64 * 1024`, checked before parsing (`pty.rs:26`); the terminal path already sizes its 16 KiB chunks so base64 + envelope stays under it (`pty.rs:19-22`). File transfer moves much more data per session and needs flow control so neither side overruns the other's buffers. The two candidate flow-control mechanisms: rely on the Rust stack's `bufferedAmount` (SCTP send-buffer occupancy), or explicit receiver acks.

**Decision.** **32 KiB raw chunks**, base64 (43 692 chars ≈ 43.7 KB) plus envelope ≈ 43.8 KB < 64 KiB — the same frame-cap discipline as the PTY path, with a larger chunk because files tolerate latency better than a terminal. **Flow control is an explicit sliding window of 16 chunks** with a cumulative `nextChunkIndex` ack per accepted chunk (§2.4), used identically in both directions. The Rust side does **not** consult `bufferedAmount`; the browser side does not either (it is not the receiver's signal). An idle transfer (no chunk and no ack for 30 s) fails with `TRANSFER_TIMEOUT` and cleans up. One transfer per direction; one download and one upload may run concurrently.

**Rationale.** `bufferedAmount` is not a portable contract across the two stacks in this repo: `webrtc` 0.21 is sans-IO and the agent's buffer visibility differs from the browser's; a window that depends on it would be tuned on one side and wrong on the other. Explicit acks are **the receiver's ground truth** ("I have 7 contiguous chunks"), are trivially unit-testable on both sides (§8), and produce identical state machines in Rust and TS. 16 × 32 KiB = 512 KiB in flight per direction bounds the agent's memory without a round-trip-per-chunk stop-and-wait; loopback E2E (§8.3) exercises the window with multi-chunk files, and the manual demo (§8.4) reports throughput informally. The 1 GiB cap is enforced on the declared/stat size, so a hostile peer cannot stream forever even with a valid window.

**Consequence.** Acks add a frame per chunk (small; same channel). A receiver MUST fail on a gap rather than skip (ordered channel ⇒ a gap is a protocol violation, `BAD_FRAME`) — this makes lost-chunk behavior deterministic instead of a silent corruption path. Week 11 may revisit chunk size/parallelism against the >10MB/s target (`ARCHITECTURE.md:1147`), which Week 10 explicitly does not chase.

### ADR-35: The server stays mode-agnostic — no sessions-table column, no new endpoints

**Context.** Files sessions could be made first-class server-side: a `mode` column on `sessions`, a `mode` field on `POST /api/sessions`, per-mode authorization, transfer history. Today the server treats every session identically (`routes/sessions.ts:48-97`; schema `apps/server/src/db/schema.ts:63-87` has no mode column) and the mode lives entirely in the offer's capability strings, relayed as opaque SDP/ICE payloads.

**Decision.** Week 10 changes **nothing** on the server: no schema/migration, no endpoint, no validation. `POST /api/sessions` stays mode-agnostic; the mode is the offer's `capabilities: ['files']`, classified by the agent (`classify_offer`) exactly as terminal/desktop already are.

**Rationale.** The server never sees data-channel bytes — it relays signaling only — so it has no enforcement role for this feature; the gate (ADR-32) and sandbox (ADR-33) live where the files are, on the agent. A `mode` column would add a migration and a second source of truth (column vs capabilities) with no consumer: nothing server-side lists, filters, authorizes, or reports on sessions by mode today. YAGNI applies; adding it now would freeze a schema decision before any feature needs it.

**Consequence (stated honestly).** The server **cannot list, filter, or authorize sessions per mode** — an operator cannot ask "which sessions were file transfers?" and a future server-side policy (e.g. "files allowed only for role X") has no hook. That is accepted for Week 10 and deferred until something needs it; the natural moment is a Phase 5 workstream (e.g. consent/audit for files) or a transfer-history feature. The `FileTransfer` shared type (`files.ts:15-27`) likewise stays unused — no persistence, no history (Non-Goal §1.2).

---

## 5. Package Design: `packages/shared` & `packages/file-core`

### 5.1 `packages/shared/src/types/files.ts` (extended)

The module keeps its five existing types and gains the payload interfaces and the error enum of §2.3, re-exported from `types/index.ts` (which already re-exports the file — the block at `:29-35` grows by the new names). No change to `webrtc.ts` (`'files'` already in the union, `:7`). `FileChunkMessage` is untouched and is used as the chunk payload in both directions.

### 5.2 `packages/file-core` (new package) — `FileClient`

A new workspace package `@ponter/file-core` (pnpm-workspace globs `packages/*` include it automatically; naming mirrors `@ponter/terminal-core`). It owns **no peer and no channel creation** — exactly like `TerminalClient`: it is constructed with an already-negotiated `DataChannelManager` and subscribes to the `'files'` label (ADR-31). Public surface:

```typescript
import type { DataChannelManager } from '@ponter/webrtc-core';
import type { TransferDirection, FilesErrorCode, FilesListResult } from '@ponter/shared';

/** The wire result minus the requestId the client consumed internally. */
export type FileListResult = Omit<FilesListResult, 'requestId'>;

export interface TransferProgress {
  transferId: string;
  direction: TransferDirection;   // 'upload' | 'download'
  bytesTransferred: number;   // contiguous bytes moved so far
  totalBytes: number;         // declared/known size
  chunkIndex: number;         // last contiguous chunk index (0-based; -1 before the first)
}

/** A handle returned by download()/upload(); progress via callbacks, abort via cancel(). */
export interface TransferHandle {
  readonly transferId: string;
  readonly direction: 'upload' | 'download';
  /** Resolves with the full payload (download: bytes; upload: nothing) or rejects with a FilesError. */
  readonly done: Promise<Uint8Array | void>;
  cancel(): void;   // idempotent; sends files-cancel and rejects `done` with code 'CANCELLED'
}

/**
 * Client-side codes: every wire code (§2.3) plus one synthetic code that never
 * appears on the wire — 'CANCELLED', raised locally by cancel()/dispose().
 */
export type FileClientErrorCode = FilesErrorCode | 'CANCELLED';

export interface FileClientOptions {
  /** Sliding-window size; default 16 (ADR-34). Test seam. */
  windowSize?: number;
  /** Idle timeout per transfer; default 30_000 ms (ADR-34). Test seam. */
  idleTimeoutMs?: number;
}

export class FileClient {
  constructor(
    public readonly agentId: string,
    dataChannelManager: DataChannelManager,
    options?: FileClientOptions,
  );

  /** List a directory. Rejects with FilesError. */
  list(path: string): Promise<FileListResult>;

  /** Download a file; `onProgress` fires per accepted chunk. */
  download(path: string, onProgress?: (p: TransferProgress) => void): TransferHandle;

  /** Upload bytes into `dirPath` under `name` (a single component). */
  upload(dirPath: string, name: string, bytes: Uint8Array, onProgress?: (p: TransferProgress) => void): TransferHandle;

  /** Subscribe to unsolicited errors (e.g. TRANSFER_TIMEOUT); returns an unsubscribe. */
  onError(handler: (code: FileClientErrorCode, message: string) => void): () => void;

  /** Unsubscribe and reject all in-flight transfers with 'CANCELLED'. */
  dispose(): void;
}

/** Error thrown/rejected by FileClient operations. */
export class FilesError extends Error {
  constructor(public readonly code: FileClientErrorCode, message: string, public readonly transferId?: string);
}
```

Semantics:

1. **Ids.** `transferId`/`requestId` are minted with `crypto.randomUUID()` (the `TerminalClient.createSession` fallback shape, `terminal-core/src/client.ts:70-73`, is reused for non-browser hosts). The agent echoes them (§2.5).
2. **`list`** sends `files-list` and resolves on the matching `files-list-result`; it also listens for a `files-error` carrying the same `requestId`. Unknown-id results are dropped with a warn. (The wire's `files-cancel` can also abort a pending list by `requestId` — the agent honors it — but the thin-slice client exposes no list-cancel handle; YAGNI, recorded here so the agent-side support is not mistaken for dead code.)
3. **`download`** sends `files-download`, then: on `files-download-begin` it initializes progress and the expected `totalChunks`; each `files-download-chunk` is appended to an in-memory buffer and answered with `files-download-ack { nextChunkIndex: contiguousCount }`; `files-download-end` resolves `done` with the buffer. A `files-error` for the id rejects `done`. `cancel()` sends `files-cancel` and rejects `done` with code `'CANCELLED'`.
4. **`upload`** sends `files-upload-begin`, then pumps chunks while respecting the window: it sends `files-upload-chunk` frames while `sent - acked < windowSize`, advancing on each `files-upload-ack`; after the last chunk it sends `files-upload-end` and resolves `done` on `files-upload-complete`. `cancel()` sends `files-cancel` and rejects.
5. **Flow control + timeout live in one place** (`packages/file-core/src/transfer.ts`, a small state machine shared by both directions): window bookkeeping, cumulative-ack validation (§2.4), idle timer reset on chunk/ack, and terminal transitions (complete/failed/cancelled). `windowSize`/`idleTimeoutMs` are constructor options so unit tests can shrink them.
6. **No peer ownership.** `dispose()` unsubscribes from the manager and rejects in-flight transfers; it never closes the channel or the peer (the store owns those, §7.2) — mirroring `TerminalClient.dispose` (`terminal-core/src/client.ts:172-187`).
7. **Channel-absence is a programming error.** Like `TerminalClient`, it relies on `sendJson` throwing when the label is not registered (`data-channel.ts:75-77`); the store only constructs a `FileClient` after `waitForChannel('files')` succeeded (§7.2), so this is not a runtime path.

Package files: `package.json` (deps `@ponter/shared`, `@ponter/webrtc-core` — the same set as `terminal-core/package.json:13-16`), `tsconfig.json`, `vitest.config.ts`, `src/{index,client,transfer,errors}.ts`, `test/{client,transfer}.test.ts`.

### 5.3 Unit tests (`packages/file-core/test/`)

- `transfer.test.ts` (state machine, no channel): window arithmetic (`sent - acked < windowSize`); ack monotonicity (duplicate/regressive ignored, future ack → `BAD_FRAME`); chunk-gap → `BAD_FRAME`; wrong chunk length → `BAD_FRAME`; idle timeout fires at `idleTimeoutMs` and rejects with `TRANSFER_TIMEOUT`; `cancel()` is idempotent and yields `'CANCELLED'`.
- `client.test.ts` (with a fake `DataChannelManager` capturing `sendJson` calls and replaying frames, mirroring `terminal-core/test/client.test.ts`): `list` happy path + error mapping (`files-error` code surfaces as `FilesError.code`); `download` happy path (begin → chunks → end, buffer bytes equal input, acks carry the right `nextChunkIndex`); `download` with a mid-stream `files-error`; `upload` happy path (begin → windowed chunks respecting acks → end → complete) including the case where acks arrive only after the window fills (sender blocks at 16, resumes on ack); `upload` rejected at begin (`FILE_EXISTS`, `FILE_TOO_LARGE`); unknown-`transferId` frames are ignored with a warn; `dispose()` rejects in-flight handles.
- Error mapping table test: every `FilesErrorCode` string round-trips (`files-error` → `FilesError.code` → UI text key).

---

## 6. Application Design: Rust Agent (`apps/agent`)

### 6.1 `apps/agent/src/files.rs` (new) — the session and the sandbox

**Not musl-gated.** The module uses only `tokio::fs`/`std::fs` and serde — no desktop dependency — so it is compiled on **every** target, and the musl artifact serves files sessions too (a change from desktop, which musl refuses; the desktop musl stub stays at `main.rs:1539-1563` and is untouched). It is declared as a plain `mod files;` next to `mod pty;` (`main.rs:10-22` shows the module block: `#[cfg(not(target_env = "musl"))] mod desktop;` at `:10-11`, `#[cfg(not(target_env = "musl"))] mod input;` at `:17-18`, then the plain `mod logging; mod pty; mod rtc; mod signal;` at `:19-22` — `files` joins the plain group).

```rust
/// One configured sandbox root, resolved once per session.
pub struct FilesRoot { canonical: PathBuf }

impl FilesRoot {
    /// Canonicalize and validate the operator's root. Err = the gate is closed.
    pub async fn resolve(raw: &str) -> Result<Self>;
    /// Validate a wire path (POSIX-relative) and return the canonical target.
    pub async fn resolve_existing(&self, wire: &str) -> Result<PathBuf>;
    /// Validate an upload target: `dir_wire` is the directory ('' = root),
    /// `name` a single component. Returns (canonical_parent, safe_name).
    pub async fn resolve_parent_for_create(&self, dir_wire: &str, name: &str) -> Result<(PathBuf, String)>;
}

/// The wire codes of §2.3; `as_str` pins the spellings (mirrors PtyErrorCode, pty.rs:53-66).
pub enum FilesErrorCode { PathOutsideRoot, InvalidPath, NotFound, NotAFile, NotADirectory,
    FileExists, FileTooLarge, TransferBusy, TransferUnknown, TransferTimeout, IoError, BadFrame }

/// One decoded inbound frame, mirroring the browser→agent payloads of §2.3.
pub enum FilesInbound {
    List(FilesListRequest),
    Download(FilesDownloadRequest),
    UploadBegin(FilesUploadBeginRequest),
    UploadChunk(FileChunkMessage),
    UploadEnd(FilesUploadEndRequest),
    Cancel(FilesCancelMessage),
    DownloadAck(FilesAckMessage),
}

/// One outbound frame the session loop writes to the data channel.
pub enum Outbound {
    ListResult(FilesListResult),
    DownloadBegin(FilesDownloadBegin),
    DownloadChunk(FileChunkMessage),
    DownloadEnd(FilesDownloadEnd),
    UploadAck(FilesAckMessage),
    UploadComplete(FilesUploadComplete),
    Error(FilesErrorMessage),
}

/// Decode an inbound frame; same guard shape as decode_pty_input (pty.rs:124-144):
/// size cap before serde, strict channel/type match, Ok(None) for non-matches.
pub fn decode_files_frame(raw: &str) -> Result<Option<FilesInbound>>;

/// Per-session transfer state: at most one download and one upload.
pub struct FilesSession { /* root, dir handle, download: Option<..>, upload: Option<..> */ }
```

`FilesSession::handle(frame) -> Vec<Outbound>` is the pure-ish core: it validates, mutates transfer state, and returns the frames to send; the session loop in `main.rs` writes them to the data channel. Keeping the I/O-touching pieces (`FilesRoot`) thin is what makes the state machine testable (§8.1). Cancellation and transfer failures are logged at **info** (`tracing::info!(transfer_id = %id, "files transfer cancelled")` / the failure code), so the E2E suite can observe them with the harness's default `RUST_LOG=info` (§8.3).

**Upload state machine.** `files-upload-begin` → validate target dir + name + `size <= FILE_TOO_LARGE` + target does not exist → create `{name}.ponter-part` (exclusive create; if it exists, that is a stale `.part` from a crashed run → remove-and-retry once, then `IO_ERROR`) → `files-upload-ack { nextChunkIndex: 0 }`. Each `files-upload-chunk` with `chunkIndex == next` → append, `next += 1`, send ack; a gap → `BAD_FRAME`, cleanup. `files-upload-end` with `next == totalChunks` → `flush` + `sync_all` + `rename` (no-replace semantics as per ADR-33; on the race losing path → `FILE_EXISTS` + cleanup) → `files-upload-complete`. Any error/cancel/disconnect → close + remove `.part`. `totalChunks` for the receiver is derived from `size` (same arithmetic as the sender, §2.5), so the ack stream and the end-check use one source of truth.

**Download.** `files-download` → resolve + stat (`NOT_A_FILE` for dirs, `FILE_TOO_LARGE` over cap) → `files-download-begin { size, totalChunks }` → pump: send up to 16 un-acked chunks (`tokio::fs::File` + `read_exact`-style bounded reads), advance on each `files-download-ack`, fail on gap/future-ack → `files-download-end` when `sent == totalChunks` and all acked. Reads happen only as the window opens, so a slow peer does not make the agent buffer the file.

**List.** `files-list` → resolve (`NOT_A_DIRECTORY` for files) → `tokio::fs::read_dir` → collect entries (name, `size` via metadata, `isDirectory`, `modifiedAt` RFC 3339 UTC), sort (directories first, then name byte-wise), truncate at 4096 with the flag → `files-list-result`. A per-entry metadata failure fails the whole list with `IO_ERROR` (a half-listed directory is worse than an error).

### 6.2 `apps/agent/src/rtc.rs` — one generalization, no new channel logic

- Add `pub const FILES_LABEL: &str = "files";` beside the existing constants (`rtc.rs:55-62`).
- Generalize the approved-answer helper: `send_desktop_answer` (`:224-237`) currently wraps `send_answer(peer, offer, true, outbound)`; Week 10 introduces `pub async fn send_approved_answer(peer, offer, outbound)` with that body and re-implements `send_desktop_answer` as a one-line delegate (keeping its name and call sites stable), used by the files branch too. This is the smallest change that gives files an `approved: true` answer without touching `answer_offer`'s terminal-only check (`:722`).
- `SessionHandler` and `on_data_channel` (`:625-651`) need **no change**: the accepted label is injected at construction (`main.rs:728-741`), and the single-channel rule is label-agnostic.

### 6.3 `apps/agent/src/main.rs` — classify, gate, dispatch

1. **CLI** (mirrors `allow_input`, `:105-113`, but is a `Option<String>`):
   ```rust
   /// Directory served by files sessions. Unset = the files gate is closed (ADR-32).
   #[arg(long, env = "AGENT_FILES_ROOT")]
   files_root: Option<String>,
   ```
   No default: absence is the gate's closed state, and `AGENT_FILES_ROOT` is the env fallback (clap resolves flag → env, ADR-13's rule).
2. **`SessionMode::Files`** arm in `classify_offer` (`:377-385`): after desktop, `else if capabilities.iter().any(|c| c == rtc::FILES_LABEL) { SessionMode::Files }`. Unit test `classify_offer_maps_capabilities_to_a_session_mode` (`:1979-1996`) gains the precedence cases (`['files']` → Files, `['files','terminal']` → Terminal, `['files','desktop']` → Desktop).
3. **`SessionConfig`** gains `files_root: Option<String>` (un-gated: files work on every target, §6.1).
4. **Gate before the answer.** In `run_one_session`, immediately **before** the mode dispatch match (`:760`) — the peer object already exists there (`build_peer` runs at `:744-751`; the `None`-mode refusal at `:779-784` uses the same shape):
   ```rust
   // Resolve the files root once per session; None = the gate is closed.
   let files_root = if mode == SessionMode::Files {
       match cfg.files_root.as_deref() {
           None => None,
           Some(raw) => files::FilesRoot::resolve(raw).await.ok(),
       }
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
   The refusal happens before `rtc::send_approved_answer`, so the browser sees `approved: false` and no files session ever starts. A files offer never reaches `answer_offer` (its terminal-only approval, `rtc.rs:722`, is not consulted). The resolved `files_root` is passed into the `SessionMode::Files` dispatch arm, so the root is validated once per session and `run_files_session` never has to re-check it.
5. **`accepted_label`** (`:728-731`) gains `SessionMode::Files => rtc::FILES_LABEL.to_string()`.
6. **Dispatch** (`:760-786`) gains a `SessionMode::Files` arm calling `run_files_session(...)` — a sibling of the terminal flow with the same order: `rtc::send_approved_answer(peer, offer, outbound)` (the generalized helper, §6.2) → `rtc::flush_pending_candidates` → wait for the `files` channel to open (bounded, like the terminal's 20 s deadline, `:952-1003`) → poll loop. The loop selects on: inbound data-channel frames (decoded via `decode_files_frame`), the session's outbound frame channel (capacity 64, mirroring `PtyManager`'s channels at `:804-810`), `end_rx`, and the existing 1 h cap; teardown closes the channel and drops the session (cancelling transfers + removing `.part`, §2.6).
7. **Files runtime** lives inside `run_files_session`'s task; `FilesSession` is not shared across tasks (single-threaded per session), so no locks beyond the existing `Arc` plumbing.

### 6.4 Rust unit tests (`files.rs` `#[cfg(test)]` + `main.rs` tests)

| Test | Asserts |
|---|---|
| `classify_offer` precedence | `['files']` → Files; `['files','desktop']` → Desktop; `['files','terminal']` → Terminal; `[]` → None (extends the existing test, `:1979-1996`) |
| path policy: `..` escape | `resolve_existing("a/../../etc/passwd")` → `PathOutsideRoot` (canonicalize resolves it, prefix check fails) |
| path policy: absolute | `/etc/passwd` → `InvalidPath` (rejected syntactically before any fs call) |
| path policy: empty component / `.` | `a//b`, `a/./b`, `''`-only components → `InvalidPath` |
| path policy: symlink escape | a symlink inside the root pointing outside → `PathOutsideRoot` (canonicalize follows it) |
| path policy: prefix confusion | root `/srv/files`, target resolving to `/srv/files2/x` → `PathOutsideRoot` (separator-anchored prefix check) |
| upload create path | `resolve_parent_for_create("dir", "name.txt")` → canonical parent under root; name `"../x"` or `"a/b"` → `InvalidPath` |
| chunk math | `totalChunks(0) = 0`; `totalChunks(32768) = 1`; `totalChunks(32769) = 2`; a 32 KiB chunk's base64 + envelope < `MAX_FRAME_BYTES`; the expected byte length of chunk `i` (full 32768 vs final short chunk) |
| decode guard | wrong channel → `Ok(None)`; wrong type → `Ok(None)`; oversize → `Err` (before parsing); malformed JSON → `Err` |
| upload happy path | begin → N chunks → end ⇒ `.part` renamed, content byte-equal, ack stream `0,1,…`, `files-upload-complete` |
| upload cancel | `files-cancel` mid-upload ⇒ `.part` removed, no final file |
| upload overwrite | existing target ⇒ `FILE_EXISTS` at begin, no `.part` created |
| upload gap | a skipped `chunkIndex` ⇒ `BAD_FRAME`, `.part` removed |
| upload short/long chunk | a non-final chunk decoding to ≠ 32768 bytes, or a final chunk with the wrong length ⇒ `BAD_FRAME`, `.part` removed |
| list cap/truncation | 4097 entries ⇒ 4096 returned, `truncated: true`, sorted (dirs first, then name) |
| list on a file | ⇒ `NOT_A_DIRECTORY` |
| oversize refusal | the pure guard `size > 1 GiB` ⇒ `FileTooLarge` at begin; the download side calls the same function on `metadata.len()` |
| busy | second download while one runs ⇒ `TRANSFER_BUSY`; a concurrent upload is allowed |
| unknown id | chunk/ack for unknown `transferId` ⇒ `TRANSFER_UNKNOWN`; `files-cancel` for unknown id ⇒ no error frame (idempotent) |
| idle timeout | with the timeout shortened via a `#[cfg(test)]`-visible constant, a transfer with no chunk/ack progress for longer than it ⇒ `TRANSFER_TIMEOUT` + `.part` removed (no 30 s real-time sleep in tests) |

All tests use temp directories created inside `std::env::temp_dir()` with a unique suffix (process id + a monotonic counter or `SystemTime::now()` nanos — no new dependency; the agent has no `uuid` crate, §2.5 keeps id minting browser-side). A tiny helper `temp_dir_for_test()` creates and cleans up the directory. If the implementer prefers `tempfile`, it is a test-only dependency added to `[dev-dependencies]` — either is acceptable; the table above is the contract.

---

## 7. Application Design: Web (`apps/web`)

### 7.1 `components/files/FilesView.vue` (new) + WorkspaceView branch

`FilesView` receives the tab and the store, and renders:

- **Toolbar**: breadcrumb (`root / dir / sub`, each segment clickable), an up button (disabled at root), a refresh button.
- **Table**: columns name / size / modified; a directory row navigates on click; a file row starts a download on click. Sizes are human-formatted (B/KiB/MiB/GiB); `modifiedAt` is rendered in local time.
- **Upload button**: a hidden `<input type="file">` triggered by the button; one file per pick; uploads into the **current** directory with the picked file's name.
- **Footer**: for each active transfer, a line with direction, name, percent (bytes contiguous / total), and a cancel button.
- **Error banner**: the last error for the tab (`tab.fileError`, a string the store maps from `FilesError.code`; e.g. `PATH_OUTSIDE_ROOT` → "The agent refused that path", `FILE_EXISTS` → "A file with that name already exists").
- **Truncation note** when `truncated` is true.
- Empty states: empty directory, and the gate-refusal state (see §7.4).

`WorkspaceView.vue` gains: a `FilesView v-else-if="terminalStore.activeTab.kind === 'files'"` branch after the DesktopView branch (`:200-204`), the `ConnectionProgress` condition widened from `kind === 'terminal'` to include `'files'` (`:212-218`), and the error overlay condition widened the same way (`:223-248`) — with `toErrorMessage` handling the `FilesError` shape (the store maps errors to strings at the tab level, §7.2).

**Download save mechanism (decided):** the store's `download` handle resolves to bytes; `FilesView` wraps them in a `Blob`, creates an object URL, and clicks a synthetic `<a download="name">`, then revokes the URL. This is the standard in-memory save path and keeps the thin slice free of File System Access API permissions. **Watch item:** the whole file lives in memory twice (client buffer + Blob) — acceptable at the 1 GiB agent cap for the demo, explicitly revisited in Week 11 (§1.2, §9.4).

### 7.2 Store changes — `stores/terminal.ts`

- `TabItem.kind` (`:28`) becomes `'terminal' | 'desktop' | 'files'`; `TabItem` gains `filesPath?: string` (current directory, default `''`), `fileList?: FileListResult`, `fileError?: string | null`, and `fileTransfers?: Array<TransferProgress & { handle: TransferHandle }>`.
- `setInitStep` (`:129-131`) kind widens to include `'files'`; `connection-steps.ts` (`:7`, `:19-31`, `:34-40`) widens its unions — `InitStep` gains `'channel'`, the `Record` and `stepIndex` kinds gain `'files'` — and `INIT_STEPS` gains a `files` entry: `session`, `ice`, `negotiating`, `channel` (label "Opening file channel").
- New `fileConnections` map (shape mirrors `desktopConnections` `:99-107`): `{ peer, client, unsubscribers }` per agent.
- **`openFilesTab(agentId, title)`** mirrors `openDesktopTab` (`:497-682`) step by step: exclusivity guard first — refuse when the agent has **any** open tab (`:503-511`'s rule, message re-used) — then push the tab (before the handshake), create the session (`POST /api/sessions`), start the transport, build the peer with `{ role: 'offerer', channelLabels: ['files'], capabilities: ['files'] }` (no `media`), `waitForChannel('files')`, orphan-release check (`:598-605` pattern: the tab may have been closed mid-handshake), construct `new FileClient(agentId, peer.dataChannels)`, set `live.initStep = 'channel'`, then `list('')` to populate the first view.
- **Exclusivity is extended asymmetrically, matching the existing guards exactly.** `openDesktopTab` refuses when the agent has **any** tab (`:503-511`), so it already refuses when a files tab exists — no change. `openTab` refuses only when the agent has a **desktop** tab (`:305-313`), so Week 10 **extends its condition** to refuse when a files tab exists too (a files session holds the agent's one ADR-14 slot; letting a terminal tab open alongside would produce a server-side refusal or a broken half-state). `openFilesTab` uses the `openDesktopTab` rule verbatim: refuse when the agent has any tab. The store test pins all directions (§8.2).
- `closeTab` (`:789-811`) dispatches a `'files'` branch: `client.dispose()`, reject in-flight handles, run unsubscribers, close the peer, delete the map entry.
- New actions: `filesNavigate(tabId, path)` (calls `list`), `filesDownload(tabId, path)` (creates a handle, wires `onProgress` into `tab.fileTransfers`, saves the blob on completion), `filesUpload(tabId, file: File)` (reads `arrayBuffer()`, creates the handle), `filesCancelTransfer(tabId, transferId)`, `clearFileError(tabId)`.
- `retryTab` (`:691-724`) gains a `'files'` branch mirroring its desktop branch.

### 7.3 Sidebar, tab bar, dialogs

- `WorkspaceSidebar.vue`: new emit `connectFiles` (`:11-14` block) and a Files button after the desktop button, `v-if="a.capabilities.includes('files')"` with `@click="$emit('connectFiles', a)"` — the desktop button's exact shape (`:151-160`). `WorkspaceView` wires the emit to `store.openFilesTab(...)` (the `connectDesktop` wiring sits at `:141`).
- `TerminalTabBar.vue`: `kind` prop widens (`:11`); the icon branch (`:64-68`) gains a files icon (`Folder` from `@lucide/vue`, which the component already imports from at `:2`).
- `RegisterAgentDialog.vue:95`: default capabilities become `['terminal', 'desktop', 'files']`.
- `EditAgentDialog.vue`: `TOGGLEABLE_CAPABILITIES` (`:33`) gains `'files'`; the two-button template (`:229-265`) gains the third toggle (`data-test="edit-cap-files"`), with the same extras-preservation behavior (`:79-91`) — a saved agent that already carries `'files'` in its extras keeps it.

### 7.4 The refusal wording (recorded limitation)

When the agent refuses a files offer at the gate, the browser's `waitForChannel` rejects with `connection.ts`'s hardcoded message: *"the agent refused the connection (one session per agent; another session is already active)"* (`:294-297`) — factually wrong for a gate refusal, and indistinguishable from an ADR-14 refusal. Week 10 **accepts** this: `webrtc-core` is outside the approved design's change set, and a generalized refusal reason (e.g. the agent echoing a reason string in the answer) is a protocol change that deserves its own decision. The store catches the rejection, marks the tab failed, and shows a combined message: *"The agent refused this session. It may be busy (one session per agent) or file access may not be configured on the agent."* — honest about the ambiguity. Generalizing the message is recorded as follow-up (§11).

### 7.5 Web tests

- `terminal-store.test.ts`-style suite (new `files-store.test.ts`, `vi.mock('@ponter/file-core')`): `openFilesTab` refuses when the agent has any open tab; `openTab`/`openDesktopTab` refuse when a files tab exists; the tab is pushed before the handshake and released when the handshake fails (orphan path); `closeTab` disposes the client and rejects handles; `filesDownload` progress updates the tab and completion triggers the save; `filesCancelTransfer` calls `handle.cancel()`.
- `FilesView.test.ts`: renders entries; directory click calls `filesNavigate`; file click calls `filesDownload`; up disabled at root; upload button reads the file input and calls `filesUpload`; progress line shows percent and cancel calls the store; error banner renders the mapped text; truncation note renders.
- `ConnectionProgress.test.ts` (the existing test for `INIT_STEPS`/`stepIndex` rendering — there is no standalone `connection-steps.test.ts`): a `kind: 'files'` tab renders the files step list with the current step active.
- Existing dialog tests: `RegisterAgentDialog.test.ts` / `EditAgentDialog.test.ts` assert the old two-capability default — they must be updated to the three-capability expectation (a required test change, §10.2 AC 2).

---

## 8. Testing & QA Plan

### 8.1 Layer 1 — Rust unit tests

Per §6.4, run by `cargo test --locked` (Linux) in the `Build Agent / Verify` job. They need no display, no network, and no Xvfb — temp directories only. The path-policy table (including the symlink-escape and `root` vs `root2` prefix-confusion cases) and the upload state machine are the security-relevant pins.

### 8.2 Layer 2 — TypeScript unit tests

Per §5.3 (`packages/file-core`) and §7.5 (`apps/web`), run by `pnpm test`. `file-core` tests use a fake `DataChannelManager` (same shape as `terminal-core/test/client.test.ts`); web tests mock `@ponter/file-core` at module level (same shape as the desktop mock in `terminal-store.test.ts`).

### 8.3 Layer 3 — cross-language E2E (`packages/webrtc-core/test/e2e/files.e2e.test.ts`, new)

**No Xvfb, no capture stack — mirror of `terminal.e2e.test.ts`** (`describe.skipIf(!isLinux)`, `setupE2E`/`teardownE2E`, 90 s test timeouts, `seed({ capabilities: ['files'] })`, `spawnAgent(agentId, credential, ['--files-root', rootDir])`, `waitForAgentOnline`, then a files peer). New harness helper `openFilesPeer(transport)` mirrors `openTerminalPeer` (`harness.ts:543-575`) with `channelLabels: ['files']` and a frame buffer; `seed()`/`spawnAgent` already accept what is needed (capabilities `:370-377`, extra args/env `:417-443`). The suite creates its own temp root under `os.tmpdir()` in `beforeAll` and removes it in `afterAll`.

| Test | Asserts |
|---|---|
| list | `files-list { path: '' }` → `files-list-result` containing the seeded files, correct `size`/`isDirectory`, `truncated: false` |
| download | seed a 600 KiB file (19 chunks — larger than the 16-chunk window, so the sender must pause for acks to finish); `files-download`; collect chunks; ack each; `files-download-end`; `Buffer.compare(assembled, seeded)` === 0 |
| upload | `files-upload-begin` (target dir, name, size) → windowed chunks (respect `files-upload-ack`) → `files-upload-end` → `files-upload-complete`; read the file from disk and `Buffer.compare`; assert no `{name}.ponter-part` remains |
| cancel mid-download | start a multi-chunk download, ack the first chunk only, send `files-cancel`; assert no further `files-download-chunk` arrives (wait a bounded window) and the agent's log contains `files transfer cancelled` (info level — visible with the harness's default `RUST_LOG=info`; §6.1 puts that log line in `FilesSession`); a subsequent `files-list` still works (session unharmed) |
| path escape | `files-download { path: '../outside' }` → `files-error` `PATH_OUTSIDE_ROOT` (also `'..'`-only and absolute variants) |
| gate off | spawn the agent **without** `--files-root`; a `files` offer is answered `approved: false`; `waitForChannel('files')` rejects; the agent log contains `refused: files root not configured or unusable` |
| overwrite | seed the target name; `files-upload-begin` → `files-error` `FILE_EXISTS`; the existing file's bytes are unchanged |
| oversize | a download of a file larger than 1 GiB is impractical to seed in CI; the cap is pinned by Rust unit tests (§6.4) and the E2E instead asserts the `FILE_TOO_LARGE` frame shape with a **declared** oversize upload (`files-upload-begin { size: 2^30 + 1 }` → `FILE_TOO_LARGE` before any chunk) |

Flow-control coverage: the download test's 19-chunk file forces the agent's sender to stop at the 16-chunk window boundary and resume only after acks — that is the window test. The upload test streams a 100 KiB file (4 chunks) with acks interleaved.

### 8.4 Manual demo (recorded)

1. Fedora dev machine; build the agent; create `/tmp/ponter-demo-files` with a few files (one > 100 MiB) and a subdirectory.
2. Run `ponter-agent --files-root /tmp/ponter-demo-files` (plus the usual credential flags).
3. `pnpm --filter @ponter/server dev` + `pnpm --filter @ponter/web dev`; register/seed the agent with the `files` capability; open a files tab.
4. Walk: root listing → enter subdirectory → breadcrumb back → download a small file (compare hash) → download the >100 MiB file (watch progress; **measure throughput informally** with a stopwatch — reported, not gated) → upload a file from the desktop → cancel a mid-flight download → attempt an overwrite (see the `FILE_EXISTS` banner) → attempt a path outside the root if a hand-crafted frame is used.
5. Run once **without** `--files-root` and confirm the files tab shows the refusal message and no session opens (the gate).
6. Record the demo; note the throughput number honestly as an informal observation (§10.2).

### 8.5 CI changes

**None expected.** The new suite lives under `packages/webrtc-core/test/e2e/`, which `vitest.e2e.config.ts` already includes and `ci-e2e.yml` already runs (`:80`); the agent binary it spawns already builds in that job (`:75`). No new system dependency (no Xvfb). **Recorded gap (not fixed):** the job's path filters (`:13-28`) do not include `packages/file-core/**`, so a PR touching only `file-core` would not trigger the E2E job; the files E2E is exercised whenever the agent, server, shared, or webrtc-core changes — which every Week 10 implementation PR does. Fixing the filter is a one-line workflow change the owner-approved design does not include; it is recorded in §11 as follow-up.

### 8.6 What is verified where

| Claim | Verified by |
|---|---|
| Path sandbox (`..`, absolute, symlink escape, prefix confusion) | Rust unit (§6.4) + E2E path-escape (§8.3) |
| Chunk math (32 KiB base64 < 64 KiB) | Rust unit (§6.4) |
| Upload atomicity (`.part` + rename; cancel cleanup) | Rust unit (§6.4) + E2E upload/cancel (§8.3) |
| Overwrite refusal | Rust unit + E2E (§8.3) |
| List cap/truncation, sorting | Rust unit (§6.4) |
| File cap on declared/stat size | Rust unit + E2E declared-oversize upload (§8.3) |
| Window + ack flow control (both directions) | `file-core` unit (§5.3) + E2E window exercise (§8.3) |
| Cancel semantics, idle timeout, gap → `BAD_FRAME` | `file-core` unit + Rust unit (§5.3, §6.4) |
| Gate refusal (`approved: false`, no session) | E2E gate-off (§8.3) |
| Real bytes both ways (download assembly, upload landing on disk) | E2E (§8.3) |
| Web UI (render, progress, cancel, error banner) | Web unit (§7.5) |
| Exclusivity across three kinds | Web unit (§7.5) |
| Throughput | Manual demo, informal (§8.4) — **not** an AC |
| Windows/macOS runtime filesystem behavior | Not verified (§3.7); compile + unit tests only |
| DTLS-only confidentiality | Protocol fact (H11 `:270`), not a test (§9) |

---

## 9. Security & Error Handling

This section carries the same weight as Week 9's, because files is a **write surface** on the host.

### 9.1 The gate (ADR-32), and what it does not fix

- **One mechanism: an agent-local flag.** `--files-root` (env `AGENT_FILES_ROOT`), resolved per offer into `SessionConfig`. A remote peer cannot set it; with it unset (or the root unusable) the files code path is unreachable from the network — the offer is refused before a session exists.
- **Honest limitation:** like ADR-29, this is a **policy** gate, not a capability gate. The shipped binary contains the file code and serves files when the flag is set; the trade-off (test fidelity vs capability gating) is the same one Week 9 recorded, and the same one applies: E2E tests the production binary with the flag on.
- **Known rough edges (recorded, not hidden):** (a) the client-side refusal message is hardcoded to the "one session per agent" wording (`connection.ts:294-297`), so a gate refusal is mislabeled in the UI until that message is generalized (§7.4, §11); (b) a gate refusal is indistinguishable from an ADR-14 refusal on the wire (both are `approved: false`).
- **The gate is not the security boundary — the sandbox is.** Even with the gate open, every path is confined to the root (ADR-33); the gate decides *whether* files are served, the sandbox decides *what* can be touched.

### 9.2 The unresolved blockers this gate stands in for

- **H3 — no peer identity verification** (`docs/security/2026-10-01-e2ee-zero-trust-audit.md:163`). Approval is granted from the offer's capability strings (`apps/agent/src/main.rs:377-385`); the agent never verifies the client. On an unverified peer, file access means an unauthenticated party can read (within the root) and write (new files) on the host. This is why the gate defaults closed and why overwrite is refused. Closed by **WS2**.
- **H2 — `approved` never enforced** (`:149`). A hostile signaling server can deliver an answer the browser honours despite `approved: false`. Week 10's gate refusal therefore relies on a browser that *chooses* to respect the flag; the enforcement workstream is **WS3**.
- **H11 — DTLS-only DataChannel traffic** (`:270`), which names "future file transfer" explicitly. File bytes and names are plaintext at the application layer; E2EE for files is **WS1** (Phase 5). The wire is JSON + base64 — serialization, not encryption.
- **M7/M8** (`:340`, `:349`) — the base64/JSON conventions this spec reuses.

**Status:** all of the above remain **open** after Week 10 merges; the gate keeps the *consequence* (usable file access against an unverified peer) from shipping by default, but the findings are untouched. §11 records this.

### 9.3 Input validation and resource bounds

- **Decode guard.** `MAX_FRAME_BYTES = 64 KiB` checked **before** `serde_json` parses (`pty.rs:26`, mirrored in `decode_files_frame`), then strict `channel == "files"` + known `type`; unknown types warn-and-ignore (§2.2); a `BAD_FRAME` never ends the session.
- **Path validation order** (§2.6) is fixed so one input maps to one code; syntactic checks precede filesystem calls, so a hostile path never reaches `canonicalize` without passing the cheap filters first.
- **Resource bounds:** 1 GiB per file (declared/stat), 4096 list entries, one transfer per direction, 16-chunk window, 30 s idle timeout, existing 1 h session cap, existing single-session-per-agent rule (ADR-14). A hostile peer can therefore at most: list 4096 names per request, transfer one ≤1 GiB file per direction concurrently, and burn the agent's ADR-14 slot while doing it — all bounded, none of it an escalation beyond the root the operator exposed.
- **A hostile peer cannot exceed the root** — that is the sandbox's job (ADR-33) and the tests pin it (§8.1, §8.3).
- **`.part` hygiene.** Every terminal transition (complete/failed/cancelled/disconnect) removes the `.part` file; a stale `.part` from a crashed run is removed-and-retried once on the next upload of the same name (§6.1) so a crash cannot brick a filename.
- **No new secrets, no new server trust.** TURN credentials unchanged; the server still relays only signaling and never sees file bytes.

### 9.4 Watch items (stated, deferred)

- **Browser memory for large files.** Thin-slice download = in-memory buffer + Blob; a 1 GiB file is loaded (roughly twice) in the tab. Accepted for the demo; Week 11 revisits with streaming-to-disk. Not a security hole, a robustness one.
- **TOCTOU around the upload parent.** The canonical parent check and the `.part` creation are separate syscalls; a local actor able to swap the parent directory between them could redirect the write *within a directory the operator already exposed*. The rename is no-replace, so no existing file is destroyed. Deferred hardening: `openat`-style dirfd operations (Unix) — recorded, not promised.
- **Symlink inside the root pointing inside the root** is allowed (canonicalize resolves it); only escapes are refused. Stated so the behavior is not a surprise.
- **One download + one upload concurrently** means a peer can hold two 1 GiB transfers and 1 MiB of window in flight; bounded by design.

---

## 10. Deliverables & Acceptance Criteria

### 10.1 Deliverables

| # | Artifact | Type |
|---|---|---|
| D1 | `packages/shared`: `types/files.ts` payload interfaces + `FilesErrorCode` + re-exports (§2.3, §5.1) | Code |
| D2 | `packages/file-core`: new package — `FileClient`, transfer state machine, error type, unit tests (§5.2, §5.3) | Code |
| D3 | `apps/agent`: `files.rs` (`FilesRoot`, `decode_files_frame`, `FilesSession`), `rtc.rs` `FILES_LABEL` + `send_approved_answer`, `main.rs` classify/gate/dispatch/CLI, Rust unit tests (§6) | Code |
| D4 | `apps/web`: `FilesView.vue`, store `openFilesTab` + actions + exclusivity, sidebar/tab-bar/dialogs, `connection-steps` union, unit tests (§7) | Code |
| D5 | `packages/webrtc-core/test/e2e/files.e2e.test.ts` + `openFilesPeer` harness helper (§8.3) | Test |
| D6 | Recorded manual demo with informal throughput note (§8.4) | Artifact |
| D7 | `docs/ARCHITECTURE.md` reconciliation + `docs/guides/agent-setup.md` `--files-root` docs (§11) | Docs |

### 10.2 Acceptance criteria

1. `cargo test --locked` passes with the new unit tests on Linux (`Build Agent / Verify`), and the **musl target still builds** — `files.rs` is not musl-gated (§6.1) and adds no dependency, so `Build Agent / Linux/x64-musl` stays green.
2. `pnpm lint && pnpm typecheck && pnpm test` pass across the workspace, including `@ponter/file-core` and the updated web dialog tests (§7.5) — the `CI (Node)` gate.
3. E2E `files.e2e.test.ts` passes on Linux: list, download (byte-equal via `Buffer.compare`), upload (byte-equal on disk, `.part` gone), cancel mid-download (session unharmed), path escape → `PATH_OUTSIDE_ROOT`, gate off → `approved: false` with the agent's refusal warn in its log, overwrite → `FILE_EXISTS`, declared-oversize upload → `FILE_TOO_LARGE` — the `CI (E2E) / Cross-language terminal E2E` gate.
4. The existing terminal and desktop E2E suites still pass unchanged; `p2p.test.ts` and all `webrtc-core` tests pass with no `webrtc-core` source change.
5. The three-way exclusivity holds in unit tests: opening a files tab is refused when the agent has any open tab, and `openTab`/`openDesktopTab` are refused when a files tab exists (ADR-14).
6. `ARCHITECTURE.md` records the Week 10 scope and the gate (§11), and `docs/guides/agent-setup.md` documents `--files-root` / `AGENT_FILES_ROOT`.
7. The recorded manual demo shows both directions working with the gate open and the refusal with the gate closed (§8.4).

**Deliverable → AC coverage** (every deliverable is exercised by at least one criterion): D1 → AC2 + AC3; D2 → AC2 + AC3; D3 → AC1 + AC3; D4 → AC2 + AC5; D5 → AC3 + AC4; D6 → AC7; D7 → AC6.

**Explicitly NOT acceptance criteria** (so the AC cannot imply more than the thin slice delivers):

- **The >10MB/s throughput target** (`ARCHITECTURE.md:1147`). Week 10 is sequential single-stream; throughput is an informal observation in the demo (§8.4), not a gate. (Same precedent as the Week 8 glass-to-glass latency note.)
- **Application-layer E2EE, peer identity, or consent (H11/M7/M8/H2/H3)** — WS1/WS2/WS3, Phase 5 (§9.2).
- **Resumable/parallel transfers, streaming large files in the browser, directory operations beyond list** — §1.2.
- **Windows/macOS runtime filesystem behavior** (§3.7).
- **The server listing or authorizing sessions by mode** — deferred (ADR-35).

### 10.3 Delivery sequence (single PR, `feat/phase4-week10-file-transfer`)

1. `packages/shared` files.ts extension (§2.3).
2. `packages/file-core` package: types, `FileClient`, transfer state machine, unit tests.
3. Agent `files.rs` + `rtc.rs` helper + `main.rs` classify/gate/dispatch/CLI + Rust unit tests.
4. Web: `connection-steps` union, store `openFilesTab`/actions/exclusivity, `FilesView`, sidebar/tab-bar/dialogs, unit tests.
5. E2E suite + harness helper.
6. `ARCHITECTURE.md` reconciliation + `agent-setup.md` docs + demo recording.
7. PR to `main`.

(The spec PR and the plan PR are separate, as with Weeks 8/9.)

### 10.4 Review focus

- **The gate is the point.** No files code path may run for an offer without a validated root; the gate-off E2E test is the contract (§8.3, ADR-32).
- **The sandbox is the other point.** Every path check goes through `FilesRoot`; the `..`/symlink/prefix-confusion tests must exist and pass (§6.4, ADR-33).
- **One channel, one label.** No new WebRTC machinery; `webrtc-core` and the server are untouched (§2.1, ADR-31/ADR-35).
- **Both directions use one chunk shape and one ack scheme** (§2.4, ADR-34) — divergence between the Rust and TS state machines is the likeliest implementation bug; the state machines are unit-tested on both sides.
- **Fail-soft.** No `files-error` ends a session (§2.6).
- **Honesty.** §1.2/§3.7/§9.2 state what is not done; §10.2 does not claim throughput or E2EE.

---

## 11. Documentation Reconciliation

Reconciled in the same PR (D7):

1. **Roadmap Phase 4** (`ARCHITECTURE.md:1003-1005`). The current stub reads "**Not yet designed.** This section is a placeholder so the roadmap does not skip from Phase 3 to Phase 5; detailed content will be added when a dedicated spec is written." Week 10 replaces the "not yet designed" blockquote with a **Week 10 (thin slice)** entry recording: the third session mode and `files` channel (ADR-31), the refuse-at-offer gate (ADR-32), the root sandbox + `.part` upload (ADR-33), the 32 KiB/window/ack protocol (ADR-34), and that the **server is unchanged** (ADR-35). It marks Week 11 (large files, streaming, performance) as **not started** — the Phase 4 item is **not** ticked done.
2. **Perf table** (`ARCHITECTURE.md:1147`, `| File Transfer | > 10MB/s | Parallel chunks |`). The row is annotated as **Week 11 scope, not yet measured**: the demo's informal number is recorded, and the row stays a target, not a claim — mirroring how the Week 8 spec handled the desktop row before the Week 8 implementation corrected it.
3. **Security status.** §9.2 records that **H11, M7, M8, H3, H2 remain open** after the Week 10 merge, and that the files gate is a holding pattern closed by **WS1/WS2/WS3** (Phase 5). The roadmap's workstream list needs no new entry.
4. **`docs/guides/agent-setup.md`.** The CLI options section (§3, `:45-60`) and env-vars section (§4.3, `:101-109`) gain `--files-root` / `AGENT_FILES_ROOT`: what it does, the fail-closed behavior, and a one-line security note (the peer is unverified until Phase 5; expose only a directory you intend to share). The section is already stale (it does not list the desktop flags either) — the implementer adds `--files-root` without attempting a full rewrite.
5. **Recorded follow-ups (not done in Week 10):** (a) generalize `connection.ts:294-297`'s hardcoded refusal message so a gate refusal is not mislabeled "one session per agent" (§7.4); (b) add `packages/file-core/**` to `ci-e2e.yml`'s path filters (§8.5); (c) browser streaming for large files and the Week 11 performance work (§1.2, §9.4).

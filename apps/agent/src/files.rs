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

// ---- binary frame codec (ADR-36) ----

/// Binary frame type for a download chunk (Agent -> Browser, ADR-36).
#[allow(dead_code)]
pub const BINARY_TYPE_DOWNLOAD_CHUNK: u8 = 0x01;
/// Binary frame type for an upload chunk (Browser -> Agent, ADR-36).
#[allow(dead_code)]
pub const BINARY_TYPE_UPLOAD_CHUNK: u8 = 0x02;
/// Total length of a binary chunk frame header: type(1) + transfer_id(16) + chunk_index(8).
#[allow(dead_code)]
pub const BINARY_HEADER_LEN: usize = 25;

/// A decoded binary chunk frame (ADR-36): raw bytes without base64 inflation.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryChunkFrame {
    pub frame_type: u8,
    pub transfer_id: [u8; 16],
    pub chunk_index: u64,
    pub data: Vec<u8>,
}

/// Encode a binary chunk frame per ADR-36:
/// `[1 byte type][16 byte transfer_id][8 byte BE chunk_index][payload]`.
#[allow(dead_code)]
pub fn encode_files_binary_frame(
    frame_type: u8,
    transfer_id: &[u8; 16],
    chunk_index: u64,
    payload: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(BINARY_HEADER_LEN + payload.len());
    out.push(frame_type);
    out.extend_from_slice(transfer_id);
    out.extend_from_slice(&chunk_index.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Decode a binary chunk frame per ADR-36.
///
/// Errors: `BadFrame` when the header is truncated or the payload exceeds
/// `FILE_CHUNK_BYTES` (spec §5.1).
#[allow(dead_code)]
pub fn decode_files_binary_frame(bytes: &[u8]) -> FilesResult<BinaryChunkFrame> {
    if bytes.len() < BINARY_HEADER_LEN {
        return Err(FilesError::new(
            FilesErrorCode::BadFrame,
            "binary frame header truncated",
        ));
    }
    if bytes.len() > BINARY_HEADER_LEN + FILE_CHUNK_BYTES as usize {
        return Err(FilesError::new(
            FilesErrorCode::BadFrame,
            "binary frame payload exceeds chunk cap",
        ));
    }
    let frame_type = bytes[0];
    let transfer_id: [u8; 16] = bytes[1..17].try_into().unwrap();
    let chunk_index = u64::from_be_bytes(bytes[17..25].try_into().unwrap());
    let data = bytes[BINARY_HEADER_LEN..].to_vec();
    Ok(BinaryChunkFrame {
        frame_type,
        transfer_id,
        chunk_index,
        data,
    })
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
    // Week 11 additions (spec §3.4, packages/shared/src/types/files.ts):
    #[allow(dead_code)]
    ResumeInvalid,
    DirNotEmpty,
    #[allow(dead_code)]
    PermissionDenied,
    #[allow(dead_code)]
    QueueFull,
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
            Self::ResumeInvalid => "RESUME_INVALID",
            Self::DirNotEmpty => "DIR_NOT_EMPTY",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::QueueFull => "QUEUE_FULL",
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
        Self {
            code,
            message: message.into(),
            request_id: None,
            transfer_id: None,
        }
    }

    /// Accessor for the error code (spec §6.4: tests inspect `err.code()`).
    #[allow(dead_code)]
    pub fn code(&self) -> FilesErrorCode {
        self.code
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
        Self::new(
            FilesErrorCode::PathOutsideRoot,
            "path escapes the configured root",
        )
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
    // Week 11 directory operations (ADR-40):
    Mkdir(FilesMkdirRequest),
    Delete(FilesDeleteRequest),
    Rename(FilesRenameRequest),
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
    // Week 11 directory operations (ADR-40):
    ActionResult(FilesActionResult),
}

// ---- Week 11 wire types for directory operations (ADR-40) ----

/// `files-mkdir` request (spec §3.3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesMkdirRequest {
    pub request_id: String,
    pub dir: String,
    pub name: String,
}

/// `files-delete` request (spec §3.3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesDeleteRequest {
    pub request_id: String,
    pub path: String,
    pub recursive: Option<bool>,
}

/// `files-rename` request (spec §3.3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesRenameRequest {
    pub request_id: String,
    pub old_path: String,
    pub new_path: String,
}

/// `files-action-result` reply (spec §3.3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilesActionResult {
    pub request_id: String,
    pub action: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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
        anyhow::bail!(
            "inbound frame exceeds {} bytes",
            crate::pty::MAX_FRAME_BYTES
        );
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
        // Week 11 directory operations (ADR-40):
        "files-mkdir" => FilesInbound::Mkdir(
            serde_json::from_value(payload).context("payload is not a FilesMkdirRequest")?,
        ),
        "files-delete" => FilesInbound::Delete(
            serde_json::from_value(payload).context("payload is not a FilesDeleteRequest")?,
        ),
        "files-rename" => FilesInbound::Rename(
            serde_json::from_value(payload).context("payload is not a FilesRenameRequest")?,
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
        Outbound::ActionResult(p) => ("files-action-result", serde_json::to_value(p)),
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
        let _ = tokio::fs::read_dir(&canonical)
            .await
            .map_err(|error| FilesError::io("files root is not readable", error))?;

        Ok(Self { canonical })
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
            return Err(FilesError::invalid_path(
                "backslash is not a POSIX path separator",
            ));
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

    /// Convenience constructor: canonicalize a path and return a `FilesRoot`.
    ///
    /// Delegates to [`FilesRoot::resolve`]; the path is converted to a string
    /// via `to_str()` (rejecting paths that aren't valid UTF-8 on the host).
    #[allow(dead_code)]
    pub async fn new(path: impl AsRef<Path>) -> FilesResult<Self> {
        let path = path.as_ref();
        let raw = path.to_str().ok_or_else(|| {
            FilesError::new(
                FilesErrorCode::InvalidPath,
                "files root path is not valid UTF-8",
            )
        })?;
        Self::resolve(raw).await
    }

    /// Create a directory inside the sandbox (ADR-40).
    ///
    /// `dir` is the parent wire path (`''` = root), `name` a single component.
    /// The parent must exist and be a directory; the target must not already
    /// exist (collision ⇒ `FILE_EXISTS`).
    pub async fn mkdir(&self, dir: &str, name: &str) -> FilesResult<()> {
        let (parent, safe_name) = self.resolve_parent_for_create(dir, name).await?;
        let target = parent.join(&safe_name);
        if tokio::fs::try_exists(&target)
            .await
            .map_err(|error| FilesError::io("probing the mkdir target", error))?
        {
            return Err(FilesError::new(
                FilesErrorCode::FileExists,
                "directory already exists",
            ));
        }
        tokio::fs::create_dir(&target)
            .await
            .map_err(|error| FilesError::io("creating directory", error))?;
        Ok(())
    }

    /// Alias for [`FilesRoot::mkdir`] — the dispatch name used by the wire layer.
    pub async fn handle_mkdir(&self, dir: &str, name: &str) -> FilesResult<()> {
        self.mkdir(dir, name).await
    }

    /// Delete a file or directory inside the sandbox (ADR-40).
    ///
    /// `recursive == true` removes a non-empty directory tree; `false` rejects
    /// a non-empty directory with `DIR_NOT_EMPTY`. The sandbox root itself is
    /// never deleted (`PERMISSION_DENIED`).
    pub async fn delete(&self, path: &str, recursive: bool) -> FilesResult<()> {
        // Reject syntactic attempts to delete the root.
        if path.is_empty() || path == "." {
            return Err(FilesError::new(
                FilesErrorCode::PermissionDenied,
                "cannot delete sandbox root",
            ));
        }
        let canonical = self.resolve_existing(path).await?;
        // Reject canonical attempts to delete the root.
        if canonical == self.canonical {
            return Err(FilesError::new(
                FilesErrorCode::PermissionDenied,
                "cannot delete sandbox root",
            ));
        }
        let metadata = tokio::fs::symlink_metadata(&canonical)
            .await
            .map_err(|error| FilesError::io("stat delete target", error))?;
        if metadata.is_dir() {
            if recursive {
                tokio::fs::remove_dir_all(&canonical)
                    .await
                    .map_err(|error| FilesError::io("removing directory tree", error))?;
            } else {
                let mut rd = tokio::fs::read_dir(&canonical)
                    .await
                    .map_err(|error| FilesError::io("reading directory for emptiness", error))?;
                if rd
                    .next_entry()
                    .await
                    .map_err(|error| {
                        FilesError::io("reading directory entry for emptiness", error)
                    })?
                    .is_some()
                {
                    return Err(FilesError::new(
                        FilesErrorCode::DirNotEmpty,
                        "directory is not empty",
                    ));
                }
                tokio::fs::remove_dir(&canonical)
                    .await
                    .map_err(|error| FilesError::io("removing directory", error))?;
            }
        } else {
            tokio::fs::remove_file(&canonical)
                .await
                .map_err(|error| FilesError::io("removing file", error))?;
        }
        Ok(())
    }

    /// Alias for [`FilesRoot::delete`] — the dispatch name used by the wire layer.
    pub async fn handle_delete(&self, path: &str, recursive: bool) -> FilesResult<()> {
        self.delete(path, recursive).await
    }

    /// Rename (move) a path within the sandbox (ADR-40).
    ///
    /// Both the source and destination must resolve inside the root. The
    /// destination must not already exist (`FILE_EXISTS`).
    pub async fn rename(&self, old_path: &str, new_path: &str) -> FilesResult<()> {
        let canonical_old = self.resolve_existing(old_path).await?;
        if canonical_old == self.canonical {
            return Err(FilesError::new(
                FilesErrorCode::PermissionDenied,
                "cannot rename sandbox root",
            ));
        }
        let (parent_dir, name) = new_path.rsplit_once('/').unwrap_or(("", new_path));
        let (canonical_parent, safe_name) =
            self.resolve_parent_for_create(parent_dir, name).await?;
        let dest = canonical_parent.join(&safe_name);
        if tokio::fs::try_exists(&dest)
            .await
            .map_err(|error| FilesError::io("probing the rename destination", error))?
        {
            return Err(FilesError::new(
                FilesErrorCode::FileExists,
                "destination already exists",
            ));
        }
        tokio::fs::rename(&canonical_old, &dest)
            .await
            .map_err(|error| FilesError::io("renaming", error))?;
        Ok(())
    }

    /// Alias for [`FilesRoot::rename`] — the dispatch name used by the wire layer.
    pub async fn handle_rename(&self, old_path: &str, new_path: &str) -> FilesResult<()> {
        self.rename(old_path, new_path).await
    }
}

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
pub struct DownloadState {
    pub transfer_id: String,
    pub file: tokio::fs::File,
    /// The file's stat size — the one source of truth for chunk lengths
    /// (`expected_chunk_len(total_chunks, size, index)`), never the frame's
    /// claim (spec §2.4).
    pub size: u64,
    pub total_chunks: u64,
    /// Next chunk index to read; also the count sent so far.
    pub sent: u64,
    /// Contiguous count the browser has acked.
    pub acked: u64,
    pub deadline: tokio::time::Instant,
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
pub struct UploadState {
    pub transfer_id: String,
    /// Full wire path of the final file (`''`-joined), for `UploadComplete`.
    pub dest_rel: String,
    /// The absolute final path; the `.part` sibling is derived from it.
    pub dest: PathBuf,
    pub part: PathBuf,
    pub file: tokio::fs::File,
    pub total_chunks: u64,
    pub expected_size: u64,
    /// Contiguous chunks accepted so far.
    pub next_chunk: u64,
    /// Total bytes written; the end-check compares it with `expected_size`.
    pub written: u64,
    pub deadline: tokio::time::Instant,
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
        Self {
            root,
            download: None,
            upload: None,
        }
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
            // Week 11 directory operations (ADR-40):
            FilesInbound::Mkdir(request) => self.handle_mkdir(request).await,
            FilesInbound::Delete(request) => self.handle_delete(request).await,
            FilesInbound::Rename(request) => self.handle_rename(request).await,
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
        tracing::info!(
            transfer_id,
            direction,
            code = "TRANSFER_TIMEOUT",
            "files transfer timed out"
        );
        FilesError::new(
            FilesErrorCode::TransferTimeout,
            format!("{direction} transfer idle for more than {FILES_IDLE_TIMEOUT_MS} ms"),
        )
        .with_ids(None, Some(transfer_id.to_string()))
        .into_frame()
    }

    /// The `TRANSFER_UNKNOWN` frame for a chunk/ack that matches nothing.
    fn transfer_unknown(transfer_id: &str) -> Outbound {
        FilesError::new(
            FilesErrorCode::TransferUnknown,
            format!("no transfer with id `{transfer_id}`"),
        )
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

    async fn handle_download(&mut self, request: FilesDownloadRequest) -> Vec<Outbound> {
        // Order of checks (spec §2.6): the path/type/cap checks run FIRST; a
        // busy slot is reported only for an otherwise-valid request.
        let target = match self.download_target(&request.path).await {
            Ok(target) => target,
            Err(error) => {
                return vec![error.with_ids(None, Some(request.transfer_id)).into_frame()]
            }
        };
        if self.download.is_some() {
            return vec![FilesError::new(
                FilesErrorCode::TransferBusy,
                "a download is already running",
            )
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
            return Err(FilesError::new(
                FilesErrorCode::NotAFile,
                format!("`{path}` is not a regular file"),
            ));
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
            name: request
                .path
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_string(),
            path: request.path,
            size,
            total_chunks: total,
        })];
        let pumped = self
            .pump_download(&mut state)
            .await
            .map_err(|error| (transfer_id, error))?;
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
        use base64::Engine as _;
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
            frames.push(Outbound::DownloadEnd(FilesDownloadEnd {
                transfer_id: state.transfer_id.clone(),
            }));
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
            return vec![
                FilesError::new(FilesErrorCode::BadFrame, "ack beyond what was sent")
                    .with_ids(None, Some(state.transfer_id))
                    .into_frame(),
            ];
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

    async fn handle_upload_begin(&mut self, request: FilesUploadBeginRequest) -> Vec<Outbound> {
        // Order of checks (spec §2.6): name grammar + resolve/type
        // (INVALID_PATH / NOT_FOUND / NOT_A_DIRECTORY), existing target
        // (FILE_EXISTS), size cap (FILE_TOO_LARGE) — busy LAST.
        let result = self.prepare_upload(&request).await;
        let (dest_rel, dest) = match result {
            Ok(prepared) => prepared,
            Err(error) => {
                return vec![error.with_ids(None, Some(request.transfer_id)).into_frame()]
            }
        };
        if self.upload.is_some() {
            return vec![FilesError::new(
                FilesErrorCode::TransferBusy,
                "an upload is already running",
            )
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
    async fn prepare_upload(
        &self,
        request: &FilesUploadBeginRequest,
    ) -> FilesResult<(String, PathBuf)> {
        // Name grammar and parent resolution/type are `resolve_parent_for_create`'s
        // job (ADR-33 rule 1; NOT_FOUND/NOT_A_DIRECTORY/INVALID_PATH).
        let (parent, name) = self
            .root
            .resolve_parent_for_create(&request.path, &request.name)
            .await?;
        let dest = parent.join(&name);
        if tokio::fs::try_exists(&dest)
            .await
            .map_err(|error| FilesError::io("probing the upload target", error))?
        {
            return Err(FilesError::new(
                FilesErrorCode::FileExists,
                format!("`{}` already exists", request.name),
            ));
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
        let file = match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)
            .await
        {
            Ok(file) => file,
            Err(first) if first.kind() == std::io::ErrorKind::AlreadyExists => {
                tokio::fs::remove_file(&part).await.map_err(|error| {
                    (
                        transfer_id.clone(),
                        FilesError::io("removing a stale .part", error),
                    )
                })?;
                tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&part)
                    .await
                    .map_err(|error| {
                        (
                            transfer_id.clone(),
                            FilesError::io("creating the upload .part", error),
                        )
                    })?
            }
            Err(error) => {
                return Err((
                    transfer_id,
                    FilesError::io("creating the upload .part", error),
                ))
            }
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
        Ok(vec![Outbound::UploadAck(FilesAckMessage {
            transfer_id,
            next_chunk_index: 0,
        })])
    }

    async fn handle_upload_chunk(&mut self, chunk: FileChunkMessage) -> Vec<Outbound> {
        let Some(state) = &mut self.upload else {
            return vec![Self::transfer_unknown(&chunk.transfer_id)];
        };
        if state.transfer_id != chunk.transfer_id {
            return vec![Self::transfer_unknown(&chunk.transfer_id)];
        }
        let state = self.upload.take().expect("checked above");
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

    /// `files-mkdir` — create a directory in the sandbox (ADR-40).
    async fn handle_mkdir(&mut self, request: FilesMkdirRequest) -> Vec<Outbound> {
        let result = self.root.handle_mkdir(&request.dir, &request.name).await;
        let frame = match result {
            Ok(()) => Outbound::ActionResult(FilesActionResult {
                request_id: request.request_id,
                action: "mkdir".to_string(),
                success: true,
                error: None,
            }),
            Err(error) => {
                tracing::warn!(error = %error, "files mkdir failed");
                Outbound::ActionResult(FilesActionResult {
                    request_id: request.request_id,
                    action: "mkdir".to_string(),
                    success: false,
                    error: Some(error.to_string()),
                })
            }
        };
        vec![frame]
    }

    /// `files-delete` — delete a file or directory in the sandbox (ADR-40).
    async fn handle_delete(&mut self, request: FilesDeleteRequest) -> Vec<Outbound> {
        let recursive = request.recursive.unwrap_or(false);
        let result = self.root.handle_delete(&request.path, recursive).await;
        let frame = match result {
            Ok(()) => Outbound::ActionResult(FilesActionResult {
                request_id: request.request_id,
                action: "delete".to_string(),
                success: true,
                error: None,
            }),
            Err(error) => {
                tracing::warn!(error = %error, "files delete failed");
                Outbound::ActionResult(FilesActionResult {
                    request_id: request.request_id,
                    action: "delete".to_string(),
                    success: false,
                    error: Some(error.to_string()),
                })
            }
        };
        vec![frame]
    }

    /// `files-rename` — rename a path within the sandbox (ADR-40).
    async fn handle_rename(&mut self, request: FilesRenameRequest) -> Vec<Outbound> {
        let result = self
            .root
            .handle_rename(&request.old_path, &request.new_path)
            .await;
        let frame = match result {
            Ok(()) => Outbound::ActionResult(FilesActionResult {
                request_id: request.request_id,
                action: "rename".to_string(),
                success: true,
                error: None,
            }),
            Err(error) => {
                tracing::warn!(error = %error, "files rename failed");
                Outbound::ActionResult(FilesActionResult {
                    request_id: request.request_id,
                    action: "rename".to_string(),
                    success: false,
                    error: Some(error.to_string()),
                })
            }
        };
        vec![frame]
    }
}

/// The `.part` sibling path of a destination (ADR-33: the final name must
/// never appear half-written).
fn part_path(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
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
#[allow(clippy::result_large_err)]
async fn accept_chunk(
    mut state: UploadState,
    chunk: FileChunkMessage,
) -> Result<UploadState, (UploadState, FilesError)> {
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
    let expected =
        expected_chunk_len(state.total_chunks, state.expected_size, state.next_chunk) as usize;
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
#[allow(clippy::result_large_err)]
async fn finalize_upload(mut state: UploadState) -> Result<Outbound, (String, FilesError)> {
    use tokio::io::AsyncWriteExt as _;
    let transfer_id = state.transfer_id.clone();
    if state.next_chunk != state.total_chunks || state.written != state.expected_size {
        state.discard().await;
        return Err((
            transfer_id,
            FilesError::new(
                FilesErrorCode::BadFrame,
                "upload ended before every chunk arrived",
            ),
        ));
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
            FilesError::new(
                FilesErrorCode::FileExists,
                "the destination was created while the upload ran",
            )
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
        name: state
            .dest_rel
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string(),
        path: state.dest_rel,
        size: state.written,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique temp dir under `std::env::temp_dir()` (spec §6.4: pid + a
    /// monotonic counter; no new dependency). Callers remove it at the end.
    fn temp_dir_for_test() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("ponter-files-test-{}-{}", std::process::id(), n));
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
        envelope(
            "files-list",
            serde_json::json!({ "requestId": "r-1", "path": "" }),
        )
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
        let huge = format!(
            "{{\"type\": \"x\", \"pad\": \"{}\"}}",
            "x".repeat(crate::pty::MAX_FRAME_BYTES)
        );
        assert!(decode_files_frame(&huge).is_err());

        // Malformed JSON → Err.
        assert!(decode_files_frame("{not json").is_err());
    }

    #[test]
    fn decode_guard_extracts_ids_for_attribution() {
        let (request_id, transfer_id) = extract_ids(&list_frame());
        assert_eq!(request_id.as_deref(), Some("r-1"));
        assert_eq!(transfer_id, None);

        let download = envelope(
            "files-download",
            serde_json::json!({ "transferId": "t-9", "path": "a.bin" }),
        );
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

        let download = envelope(
            "files-download",
            serde_json::json!({ "transferId": "t-1", "path": "a.bin" }),
        );
        assert!(
            matches!(decode_files_frame(&download).unwrap().unwrap(), FilesInbound::Download(ref d) if d.transfer_id == "t-1")
        );

        let begin = envelope(
            "files-upload-begin",
            serde_json::json!({ "transferId": "t-2", "path": "dir", "name": "up.bin", "size": 5 }),
        );
        assert!(
            matches!(decode_files_frame(&begin).unwrap().unwrap(), FilesInbound::UploadBegin(ref b) if b.name == "up.bin" && b.size == 5)
        );

        let chunk = envelope(
            "files-upload-chunk",
            serde_json::json!({ "transferId": "t-2", "chunkIndex": 0, "totalChunks": 1, "data": "AA==" }),
        );
        assert!(
            matches!(decode_files_frame(&chunk).unwrap().unwrap(), FilesInbound::UploadChunk(ref c) if c.chunk_index == 0)
        );

        let end = envelope(
            "files-upload-end",
            serde_json::json!({ "transferId": "t-2" }),
        );
        assert!(
            matches!(decode_files_frame(&end).unwrap().unwrap(), FilesInbound::UploadEnd(ref e) if e.transfer_id == "t-2")
        );

        let cancel = envelope("files-cancel", serde_json::json!({ "transferId": "t-2" }));
        assert!(
            matches!(decode_files_frame(&cancel).unwrap().unwrap(), FilesInbound::Cancel(ref c) if c.transfer_id.as_deref() == Some("t-2"))
        );

        let ack = envelope(
            "files-download-ack",
            serde_json::json!({ "transferId": "t-1", "nextChunkIndex": 3 }),
        );
        assert!(
            matches!(decode_files_frame(&ack).unwrap().unwrap(), FilesInbound::DownloadAck(ref a) if a.next_chunk_index == 3)
        );
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
        let error = FilesError::new(FilesErrorCode::BadFrame, "chunk gap")
            .with_ids(None, Some("t-1".to_string()));
        let frame = frame_files(&Outbound::Error(FilesErrorMessage::from_error(&error)), 0);
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
        std::fs::create_dir(dir.join("a")).unwrap();
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

        let root = FilesRoot::resolve(root_dir.to_str().unwrap())
            .await
            .unwrap();
        let err = root.resolve_existing("../files2/x").await.unwrap_err();
        assert_eq!(err.code, FilesErrorCode::PathOutsideRoot);
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn upload_create_path_validates_parent_and_name() {
        let dir = temp_dir_for_test();
        std::fs::create_dir(dir.join("dir")).unwrap();
        let root = FilesRoot::resolve(dir.to_str().unwrap()).await.unwrap();

        let (parent, name) = root
            .resolve_parent_for_create("dir", "name.txt")
            .await
            .unwrap();
        assert_eq!(parent, dir.join("dir").canonicalize().unwrap());
        assert_eq!(name, "name.txt");

        for bad in ["../x", "a/b", "..", "."] {
            let err = root
                .resolve_parent_for_create("dir", bad)
                .await
                .unwrap_err();
            assert_eq!(err.code, FilesErrorCode::InvalidPath, "name: {bad}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FilesSession state machine (spec §6.4) ----

    /// A session rooted at a fresh temp dir (the dir itself is created by
    /// `temp_dir_for_test`; callers remove it at the end).
    async fn session_for(dir: &std::path::Path) -> FilesSession {
        let root = FilesRoot::resolve(dir.to_str().unwrap()).await.unwrap();
        FilesSession::new(root)
    }

    fn list_req(id: &str, path: &str) -> FilesInbound {
        FilesInbound::List(FilesListRequest {
            request_id: id.to_string(),
            path: path.to_string(),
        })
    }

    fn download_req(id: &str, path: &str) -> FilesInbound {
        FilesInbound::Download(FilesDownloadRequest {
            transfer_id: id.to_string(),
            path: path.to_string(),
        })
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
        FilesInbound::UploadEnd(FilesUploadEndRequest {
            transfer_id: id.to_string(),
        })
    }

    fn ack(id: &str, next: u64) -> FilesInbound {
        FilesInbound::DownloadAck(FilesAckMessage {
            transfer_id: id.to_string(),
            next_chunk_index: next,
        })
    }

    fn cancel(id: &str) -> FilesInbound {
        FilesInbound::Cancel(FilesCancelMessage {
            request_id: None,
            transfer_id: Some(id.to_string()),
        })
    }

    /// The decoded bytes of one `files-download-chunk` frame.
    fn chunk_bytes(frame: &Outbound) -> Vec<u8> {
        use base64::Engine as _;
        let Outbound::DownloadChunk(chunk) = frame else {
            panic!("not a download chunk: {frame:?}");
        };
        base64::engine::general_purpose::STANDARD
            .decode(&chunk.data)
            .unwrap()
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
        assert_eq!(
            names,
            ["zz-dir", "a.txt", "b.txt"],
            "dirs first, then name bytewise"
        );
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
        assert!(
            matches!(frames.first(), Some(Outbound::DownloadBegin(b)) if b.total_chunks == 20 && b.size == size as u64)
        );
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
        let content: Vec<u8> = (0..(FILE_CHUNK_BYTES as usize + 3))
            .map(|i| (i % 251) as u8)
            .collect();
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
        assert!(
            matches!(frames.as_slice(), [Outbound::DownloadBegin(b), Outbound::DownloadEnd(_)] if b.total_chunks == 0)
        );

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
        assert_eq!(
            ensure_within_cap(FILE_MAX_BYTES + 1).unwrap_err().code,
            FilesErrorCode::FileTooLarge
        );

        // The upload path calls it at begin, before any chunk or file.
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        let frames = session
            .handle(upload_begin("t-1", "", "big", FILE_MAX_BYTES + 1))
            .await;
        assert_eq!(error_code(&frames), "FILE_TOO_LARGE");
        assert!(!dir.join(part_name("big")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn upload_happy_path_writes_the_file_and_cleans_the_part() {
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        let payload = b"hello files";

        // Begin is answered with the first cumulative ack (spec §6.1).
        let frames = session
            .handle(upload_begin("t-1", "", "note.txt", payload.len() as u64))
            .await;
        assert!(
            matches!(frames.as_slice(), [Outbound::UploadAck(a)] if a.transfer_id == "t-1" && a.next_chunk_index == 0)
        );
        assert!(
            dir.join(part_name("note.txt")).exists(),
            ".part is created at begin"
        );

        let frames = session.handle(chunk("t-1", 0, 1, payload)).await;
        assert!(matches!(frames.as_slice(), [Outbound::UploadAck(a)] if a.next_chunk_index == 1));
        let frames = session.handle(upload_end("t-1")).await;
        assert!(matches!(frames.as_slice(), [Outbound::UploadComplete(c)]
            if c.transfer_id == "t-1" && c.name == "note.txt" && c.path == "note.txt" && c.size == payload.len() as u64));
        assert_eq!(std::fs::read(dir.join("note.txt")).unwrap(), payload);
        assert!(
            !dir.join(part_name("note.txt")).exists(),
            ".part renamed away"
        );
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
        let frames = session
            .handle(upload_begin("t-1", "nope", "f.bin", 1))
            .await;
        assert_eq!(
            error_code(&frames),
            "NOT_FOUND",
            "the missing dir fails the resolve"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn upload_of_an_existing_name_is_already_exists() {
        let dir = temp_dir_for_test();
        std::fs::write(dir.join("taken.txt"), b"x").unwrap();
        let mut session = session_for(&dir).await;
        let frames = session
            .handle(upload_begin("t-1", "", "taken.txt", 1))
            .await;
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
        assert!(
            matches!(frames.as_slice(), [Outbound::UploadAck(_)]),
            "begin succeeds over a stale .part"
        );
        assert_eq!(
            std::fs::read(dir.join(part_name("note.txt"))).unwrap(),
            b"",
            "stale bytes are gone"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn upload_end_before_the_last_chunk_is_bad_frame() {
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        session
            .handle(upload_begin("t-1", "", "two.bin", 2 * FILE_CHUNK_BYTES))
            .await;
        session
            .handle(chunk("t-1", 0, 2, &vec![1u8; FILE_CHUNK_BYTES as usize]))
            .await;

        let frames = session.handle(upload_end("t-1")).await;
        assert_eq!(error_code(&frames), "BAD_FRAME");
        assert!(
            !dir.join(part_name("two.bin")).exists(),
            "state cleared and .part removed"
        );
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
        let size = 2 * FILE_CHUNK_BYTES + 5;

        let frames = session
            .handle(upload_begin("t-1", "", "three.bin", size))
            .await;
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
        let size = FILE_CHUNK_BYTES + 3;
        session.handle(upload_begin("t-1", "", "s.bin", size)).await;
        session
            .handle(chunk("t-1", 0, 2, &vec![1u8; FILE_CHUNK_BYTES as usize]))
            .await;
        let frames = session.handle(chunk("t-1", 1, 2, b"ab")).await;
        assert_eq!(error_code(&frames), "BAD_FRAME");
        assert!(!dir.join(part_name("s.bin")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn upload_totals_changed_mid_flight_is_bad_frame() {
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        session
            .handle(upload_begin("t-1", "", "m.bin", FILE_CHUNK_BYTES))
            .await;
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
        assert_eq!(
            std::fs::read(dir.join("race.bin")).unwrap(),
            b"winner",
            "the existing file is untouched"
        );
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
        let Outbound::Error(error) = &frames[0] else {
            unreachable!()
        };
        assert_eq!(
            error.transfer_id.as_deref(),
            Some("t-2"),
            "the busy error names the offending id"
        );

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
        assert!(
            session.download.is_none(),
            "the slot is free after the end frame"
        );

        // A second download (new id, other file) must begin, not be busy.
        let frames = session.handle(download_req("t-2", "b.bin")).await;
        assert!(
            matches!(frames.first(), Some(Outbound::DownloadBegin(_))),
            "not TRANSFER_BUSY"
        );
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
        assert!(
            !dir.join(part_name("up.bin")).exists(),
            ".part removed on cancel"
        );
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

        assert!(
            session.check_idle().await.is_empty(),
            "fresh transfer is not idle"
        );

        // Rewind the deadline past the timeout; the tick then fails it.
        session.download.as_mut().unwrap().deadline =
            tokio::time::Instant::now() - std::time::Duration::from_secs(1);
        let frames = session.check_idle().await;
        let Outbound::Error(error) = &frames[0] else {
            panic!("expected the timeout frame, got {frames:?}")
        };
        assert_eq!(error.code, "TRANSFER_TIMEOUT");
        assert_eq!(error.transfer_id.as_deref(), Some("t-1"));

        let frames = session.handle(ack("t-1", 1)).await;
        assert_eq!(
            error_code(&frames),
            "TRANSFER_UNKNOWN",
            "state cleaned after timeout"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn idle_timeout_removes_a_stalled_uploads_part() {
        let dir = temp_dir_for_test();
        let mut session = session_for(&dir).await;
        session.handle(upload_begin("u-1", "", "up.bin", 10)).await;
        session.upload.as_mut().unwrap().deadline =
            tokio::time::Instant::now() - std::time::Duration::from_secs(1);

        let frames = session.check_idle().await;
        assert!(matches!(frames.as_slice(), [Outbound::Error(e)] if e.code == "TRANSFER_TIMEOUT"));
        assert!(
            !dir.join(part_name("up.bin")).exists(),
            ".part removed on timeout"
        );
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

    #[tokio::test]
    async fn root_resolution_fails_when_missing_not_a_dir_or_unreadable() {
        // Missing path.
        let missing =
            std::env::temp_dir().join(format!("ponter-files-missing-{}", std::process::id()));
        assert_eq!(
            FilesRoot::resolve(missing.to_str().unwrap())
                .await
                .unwrap_err()
                .code,
            FilesErrorCode::NotFound
        );

        // A file is not a directory.
        let dir = temp_dir_for_test();
        let file = dir.join("plain.txt");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(
            FilesRoot::resolve(file.to_str().unwrap())
                .await
                .unwrap_err()
                .code,
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
                    FilesRoot::resolve(locked.to_str().unwrap())
                        .await
                        .unwrap_err()
                        .code,
                    FilesErrorCode::IoError
                );
            }
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).ok();
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod tests_week11 {
    use super::*;

    /// Unique temp dir under `std::env::temp_dir()` (mirrors the `tests`
    /// helper; duplicated here because `tempfile` is not a declared dev-dep).
    fn temp_dir_for_test() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("ponter-files-w11-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_binary_frame_roundtrip() {
        let transfer_id = [7u8; 16];
        let chunk_index = 42u64;
        let payload = b"hello binary world";
        let encoded = encode_files_binary_frame(
            BINARY_TYPE_DOWNLOAD_CHUNK,
            &transfer_id,
            chunk_index,
            payload,
        );
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
        // Adapt the brief's `tempfile::tempdir()` to the existing test helper
        // (`tempfile` is a transitive dep in Cargo.lock but not declared in
        // Cargo.toml; we cannot add it here).
        let temp = temp_dir_for_test();
        let root = FilesRoot::new(&temp).await.unwrap();

        // 1. mkdir
        root.mkdir("", "test_dir").await.unwrap();
        let created = temp.join("test_dir");
        assert!(created.is_dir());

        // 2. rename
        tokio::fs::write(created.join("sample.txt"), b"data")
            .await
            .unwrap();
        root.rename("test_dir/sample.txt", "test_dir/renamed.txt")
            .await
            .unwrap();
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

        std::fs::remove_dir_all(&temp).ok();
    }

    // ---- Fix round 1: boundary + rename + error-code mapping tests ----

    #[test]
    fn test_binary_frame_max_payload_decodes() {
        // 32793 bytes = 25 header + 32768 payload (the exact boundary).
        let transfer_id = [9u8; 16];
        let payload = vec![0xABu8; 32768];
        let encoded =
            encode_files_binary_frame(BINARY_TYPE_DOWNLOAD_CHUNK, &transfer_id, 0, &payload);
        assert_eq!(encoded.len(), 32793);

        let decoded = decode_files_binary_frame(&encoded).expect("decode should succeed");
        assert_eq!(decoded.frame_type, BINARY_TYPE_DOWNLOAD_CHUNK);
        assert_eq!(decoded.transfer_id, transfer_id);
        assert_eq!(decoded.chunk_index, 0);
        assert_eq!(decoded.data.len(), 32768);
    }

    #[test]
    fn test_binary_frame_oversized_payload_rejected() {
        // 32794 bytes = 25 header + 32769 payload (one byte over the cap).
        let transfer_id = [9u8; 16];
        let payload = vec![0xABu8; 32769];
        let encoded =
            encode_files_binary_frame(BINARY_TYPE_DOWNLOAD_CHUNK, &transfer_id, 0, &payload);
        let err = decode_files_binary_frame(&encoded).unwrap_err();
        assert_eq!(err.code(), FilesErrorCode::BadFrame);
    }

    #[tokio::test]
    async fn test_rename_root_rejected() {
        let temp = temp_dir_for_test();
        let root = FilesRoot::new(&temp).await.unwrap();
        // old path "" resolves to root -> PermissionDenied.
        let err = root.rename("", "x.txt").await.unwrap_err();
        assert_eq!(err.code(), FilesErrorCode::PermissionDenied);
        std::fs::remove_dir_all(&temp).ok();
    }

    #[tokio::test]
    async fn test_rename_destination_existing_rejected() {
        let temp = temp_dir_for_test();
        let root = FilesRoot::new(&temp).await.unwrap();

        // Create source and a pre-existing destination.
        tokio::fs::write(temp.join("src.txt"), b"source")
            .await
            .unwrap();
        tokio::fs::write(temp.join("dest.txt"), b"dest")
            .await
            .unwrap();

        let err = root.rename("src.txt", "dest.txt").await.unwrap_err();
        assert_eq!(err.code(), FilesErrorCode::FileExists);
        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn test_error_code_str_mapping() {
        assert_eq!(FilesErrorCode::ResumeInvalid.as_str(), "RESUME_INVALID");
        assert_eq!(FilesErrorCode::QueueFull.as_str(), "QUEUE_FULL");
    }
}

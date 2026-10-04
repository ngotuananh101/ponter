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
        let _ = tokio::fs::read_dir(&canonical)
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
        let huge = format!("{{\"type\": \"x\", \"pad\": \"{}\"}}", "x".repeat(crate::pty::MAX_FRAME_BYTES));
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

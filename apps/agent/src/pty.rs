//! PTY bridge: spawn a shell, pump bytes both ways, frame them as base64.
//!
//! **No UTF-8 assumption anywhere.** Bytes move as `Vec<u8>` and are
//! base64-encoded, so a multi-byte sequence split across two `read()` calls is
//! harmless (ADR-10). This is the single most important property of the pump: a
//! "looks fine on my machine" implementation passes every unit test and
//! corrupts output in production.

use std::io::{Read, Write};
use std::time::Duration;

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// 16 KiB raw becomes ~21 848 base64 characters, plus the JSON envelope
/// (~120 bytes) — comfortably under the browser DataChannel's default
/// `maxMessageSize` (64 KiB in Chromium) and under the SCTP limit.
pub const MAX_PTY_CHUNK: usize = 16 * 1024;

/// Inbound guard, checked **before** `serde_json` parses, so a hostile peer
/// cannot make the agent allocate arbitrarily.
pub const MAX_FRAME_BYTES: usize = 64 * 1024;

/// `data` is standard base64 of the raw bytes — the shape
/// `packages/shared/src/types/terminal.ts:16-19` declares.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataMessage {
    pub terminal_id: String,
    pub data: String,
}

/// The envelope from `packages/shared/src/types/webrtc.ts:9-14`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataChannelMessage<T> {
    pub r#type: String,
    pub channel: String,
    pub payload: T,
    pub timestamp: i64,
}

/// Why a terminal could not be produced, on the wire.
///
/// Without this the agent can only `tracing::warn!` and the browser is left
/// staring at a terminal that opened and stayed blank, with no way to tell a
/// missing shell from a slow one. The spellings are a wire contract — the
/// browser switches on them — so they are pinned by a test.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyErrorCode {
    SpawnFailed,
    SessionLimitReached,
}

impl PtyErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SpawnFailed => "pty-spawn-failed",
            Self::SessionLimitReached => "session-limit-reached",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalErrorMessage {
    pub terminal_id: String,
    pub code: String,
    pub message: String,
}

/// Encode a terminal failure as a `terminal-error` frame.
///
/// Same shape and same clock-injection as [`frame_pty_output`], for the same
/// reason: framing stays pure so it can be tested.
pub fn frame_pty_error(
    terminal_id: &str,
    code: PtyErrorCode,
    message: &str,
    timestamp_ms: i64,
) -> String {
    let message = DataChannelMessage {
        r#type: "terminal-error".to_string(),
        channel: "terminal".to_string(),
        payload: TerminalErrorMessage {
            terminal_id: terminal_id.to_string(),
            code: code.as_str().to_string(),
            message: message.to_string(),
        },
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("a frame of strings cannot fail to serialize")
}

/// A frame the pump will emit. Control frames stay pre-serialized JSON; terminal
/// output carries raw bytes so the pump can encrypt before framing.
#[derive(Debug, Clone)]
pub enum Outbound {
    /// A pre-serialized JSON frame that is never encrypted (control frames).
    Json(String),
    /// Terminal output bytes, framed (and encrypted when the session is active).
    TerminalData {
        terminal_id: String,
        bytes: Vec<u8>,
        timestamp_ms: i64,
    },
}

/// Build the `terminal-data` frame JSON. `data` is the (possibly encrypted)
/// payload; base64-encoding happens here so both paths share one spelling.
///
/// The wire shape is the NESTED `DataChannelMessage` envelope — reuse the same
/// struct `frame_pty_output` uses so the plaintext path stays byte-identical:
/// `{"type":"terminal-data","channel":"terminal","payload":{"terminalId":..,"data":..},"timestamp":..}`.
pub fn build_terminal_data_frame(terminal_id: &str, data: &[u8], timestamp_ms: i64) -> String {
    let message = DataChannelMessage {
        r#type: "terminal-data".to_string(),
        channel: "terminal".to_string(),
        payload: TerminalDataMessage {
            terminal_id: terminal_id.to_string(),
            data: STANDARD.encode(data),
        },
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("a frame of strings cannot fail to serialize")
}

/// Encode raw PTY bytes as a `terminal-data` frame.
///
/// `timestamp` is passed in rather than read from the clock here so the framing
/// function stays pure and testable.
#[allow(dead_code)]
pub fn frame_pty_output(terminal_id: &str, bytes: &[u8], timestamp_ms: i64) -> String {
    build_terminal_data_frame(terminal_id, bytes, timestamp_ms)
}

/// Decode an inbound `terminal-data` frame.
///
/// Returns `Ok(None)` when the frame is not a `terminal-data` frame on the
/// `terminal` channel (the agent ignores any other channel, per ADR-09) and
/// `Err` when it is but cannot be decoded. Strict, padded standard alphabet
/// (spec R16): a lenient decode would silently accept a frame the browser
/// never meant to send.
#[allow(dead_code)]
pub fn decode_pty_input(raw: &str) -> Result<Option<Vec<u8>>> {
    if raw.len() > MAX_FRAME_BYTES {
        anyhow::bail!("inbound frame exceeds {MAX_FRAME_BYTES} bytes");
    }

    let envelope: DataChannelMessage<serde_json::Value> =
        serde_json::from_str(raw).context("inbound frame is not a DataChannelMessage")?;

    if envelope.channel != "terminal" || envelope.r#type != "terminal-data" {
        return Ok(None);
    }

    let payload: TerminalDataMessage =
        serde_json::from_value(envelope.payload).context("payload is not a TerminalDataMessage")?;

    let bytes = STANDARD
        .decode(payload.data.as_bytes())
        .context("payload.data is not valid standard-base64")?;

    Ok(Some(bytes))
}

/// Decode an inbound `terminal-data` frame, returning the terminal id and bytes.
///
/// Like `decode_pty_input` but also returns the `terminal_id` so the dispatcher
/// can route the bytes to the right PTY session. Returns `Ok(None)` for any
/// frame that is not a `terminal-data` frame on the `terminal` channel.
#[allow(dead_code)]
pub fn decode_pty_input_with_id(raw: &str) -> Result<Option<(String, Vec<u8>)>> {
    if raw.len() > MAX_FRAME_BYTES {
        anyhow::bail!("inbound frame exceeds {MAX_FRAME_BYTES} bytes");
    }

    let envelope: DataChannelMessage<TerminalDataMessage> =
        serde_json::from_str(raw).context("inbound frame is not a DataChannelMessage")?;

    if envelope.channel != "terminal" || envelope.r#type != "terminal-data" {
        return Ok(None);
    }

    let bytes = STANDARD
        .decode(envelope.payload.data.as_bytes())
        .context("payload.data is not valid standard-base64")?;

    Ok(Some((envelope.payload.terminal_id, bytes)))
}

/// Decode an inbound `terminal-create` frame.
#[allow(dead_code)]
pub fn decode_terminal_create(raw: &str) -> Result<Option<TerminalCreateMessage>> {
    if raw.len() > MAX_FRAME_BYTES {
        anyhow::bail!("inbound frame exceeds {MAX_FRAME_BYTES} bytes");
    }

    let envelope: DataChannelMessage<serde_json::Value> =
        serde_json::from_str(raw).context("inbound frame is not a DataChannelMessage")?;

    if envelope.channel != "terminal" || envelope.r#type != "terminal-create" {
        return Ok(None);
    }

    let payload: TerminalCreateMessage = serde_json::from_value(envelope.payload)
        .context("payload is not a TerminalCreateMessage")?;

    Ok(Some(payload))
}

/// Decode an inbound `terminal-resize` frame.
#[allow(dead_code)]
pub fn decode_terminal_resize(raw: &str) -> Result<Option<TerminalResizeMessage>> {
    if raw.len() > MAX_FRAME_BYTES {
        anyhow::bail!("inbound frame exceeds {MAX_FRAME_BYTES} bytes");
    }

    let envelope: DataChannelMessage<serde_json::Value> =
        serde_json::from_str(raw).context("inbound frame is not a DataChannelMessage")?;

    if envelope.channel != "terminal" || envelope.r#type != "terminal-resize" {
        return Ok(None);
    }

    let payload: TerminalResizeMessage = serde_json::from_value(envelope.payload)
        .context("payload is not a TerminalResizeMessage")?;

    Ok(Some(payload))
}

/// Decode an inbound `terminal-close` frame.
#[allow(dead_code)]
pub fn decode_terminal_close(raw: &str) -> Result<Option<TerminalCloseMessage>> {
    if raw.len() > MAX_FRAME_BYTES {
        anyhow::bail!("inbound frame exceeds {MAX_FRAME_BYTES} bytes");
    }

    let envelope: DataChannelMessage<serde_json::Value> =
        serde_json::from_str(raw).context("inbound frame is not a DataChannelMessage")?;

    if envelope.channel != "terminal" || envelope.r#type != "terminal-close" {
        return Ok(None);
    }

    let payload: TerminalCloseMessage = serde_json::from_value(envelope.payload)
        .context("payload is not a TerminalCloseMessage")?;

    Ok(Some(payload))
}

/// Resize a PTY session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeMessage {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// Exit notification for a PTY session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitMessage {
    pub terminal_id: String,
    pub exit_code: Option<u32>,
}

/// Create notification for a new PTY session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateMessage {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
    pub shell: Option<String>,
}

/// Close notification for a PTY session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCloseMessage {
    pub terminal_id: String,
}

/// Encode an exit notification as a `terminal-exit` frame.
pub fn frame_pty_exit(terminal_id: &str, exit_code: Option<u32>, timestamp_ms: i64) -> String {
    let message = DataChannelMessage {
        r#type: "terminal-exit".to_string(),
        channel: "terminal".to_string(),
        payload: TerminalExitMessage {
            terminal_id: terminal_id.to_string(),
            exit_code,
        },
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("serialization of exit frame cannot fail")
}

/// A spawned shell on a PTY.
pub struct PtySession {
    /// Held for its lifetime, never read: `try_clone_reader()` borrows it, so
    /// dropping it would close the PTY. `dead_code` is expected here.
    #[allow(dead_code)]
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl PtySession {
    /// Spawn the shell and start both pump directions.
    ///
    /// **`input` is created by the caller, not here.** The browser can send a
    /// keystroke the instant its data channel reports `open`, which is before
    /// this function runs — so a sender created inside `spawn` would not exist
    /// yet and those first bytes would be silently dropped. Taking the receiver
    /// as a parameter lets the caller install the sending half in the
    /// `on_data_channel` callback first, which removes the race by construction
    /// rather than by hoping the handshake is slow.
    ///
    /// `try_clone_reader()` and `take_writer()` are **blocking** `std::io`
    /// objects (spec R10), so each direction gets a dedicated `spawn_blocking`
    /// thread bridged to async by a bounded channel (ADR-11).
    pub fn spawn(
        shell: &str,
        cols: u16,
        rows: u16,
        mut input: mpsc::Receiver<Vec<u8>>,
    ) -> Result<Self> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty")?;

        let mut cmd = CommandBuilder::new(shell);
        cmd.env("TERM", "xterm-256color"); // the browser terminal is xterm.js (Week 6)
        cmd.env("LANG", "C.UTF-8");
        let child = pair.slave.spawn_command(cmd).context("spawn_command")?;

        // NOT optional: holding the slave end open keeps the PTY from reporting
        // EOF when the child exits, and the reader loop then never terminates.
        drop(pair.slave);

        // browser -> PTY
        let writer = pair.master.take_writer().context("take_writer")?;
        tokio::task::spawn_blocking(move || {
            let mut writer = writer;
            while let Some(bytes) = input.blocking_recv() {
                if writer.write_all(&bytes).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
            // Dropping `writer` here sends EOF to the slave end (spec R10).
        });

        Ok(Self {
            master: pair.master,
            child,
        })
    }

    /// Start the PTY -> caller direction and return the frame receiver.
    ///
    /// **Frames are delivered in read order.** The reader thread is
    /// single-threaded and the converter `await`s on its send, so ordering is
    /// structural rather than incidental — a terminal whose output is reordered
    /// is a corrupted terminal. Returning a receiver rather than taking a
    /// callback is what makes that guarantee expressible: a callback that
    /// spawned a task per frame would let the runtime reorder them.
    ///
    /// Backpressure is the bounded queue (ADR-11): a slow consumer fills it,
    /// `blocking_send` blocks the reader thread, the kernel PTY buffer fills,
    /// and the child blocks on write. There is no unbounded queue anywhere in
    /// this path.
    pub fn start_reader(&self, terminal_id: String) -> Result<mpsc::Receiver<Outbound>> {
        let mut reader = self.master.try_clone_reader().context("try_clone_reader")?;
        let (raw_tx, mut raw_rx) = mpsc::channel::<Vec<u8>>(64);

        tokio::task::spawn_blocking(move || {
            let mut buf = vec![0u8; MAX_PTY_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // child exited, slave closed
                    Ok(n) => {
                        if raw_tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break; // consumer gone
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "pty read failed");
                        break;
                    }
                }
            }
        });

        let (frame_tx, frame_rx) = mpsc::channel::<Outbound>(64);
        tokio::spawn(async move {
            while let Some(bytes) = raw_rx.recv().await {
                let frame = Outbound::TerminalData {
                    terminal_id: terminal_id.clone(),
                    bytes,
                    timestamp_ms: now_ms(),
                };
                if frame_tx.send(frame).await.is_err() {
                    break; // caller dropped the receiver
                }
            }
        });

        Ok(frame_rx)
    }

    /// Resize the PTY to `cols` x `rows`.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("resize pty")
    }

    /// Wait for the child process to exit, returning its exit code.
    ///
    /// Calls `self.child.wait()` — a blocking call — to reap the child process
    /// and obtain its exit code. In practice the child has already exited by the
    /// time this is called (the reader loop reached EOF), so `wait()` returns
    /// immediately. Used by `PtyManager` to report the real exit code to the
    /// browser instead of a hardcoded `Some(0)` and to prevent zombies.
    pub fn wait_child(&mut self) -> Option<u32> {
        self.child.wait().ok().map(|s| s.exit_code())
    }

    /// Drop the writer, signal, then wait **with a timeout**.
    ///
    /// `Child::wait` is blocking (spec R10) and a wedged child must not hang the
    /// agent's exit path. On timeout the failure is logged and the process exits
    /// regardless.
    pub async fn close(mut self) -> Result<()> {
        // The caller drops its input sender when the session ends; that drains
        // the writer thread, which drops `writer` and sends EOF to the slave.
        // The `kill` below is the belt-and-braces path for a shell that ignores
        // EOF (a job-control shell with a background child, for instance).
        let _ = self.child.kill(); // SIGHUP on unix, TerminateProcess on windows
        let mut child = self.child;

        if tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || child.wait()),
        )
        .await
        .is_err()
        {
            tracing::warn!("pty child did not exit within 2s; abandoning it");
        }

        Ok(())
    }
}

/// Epoch milliseconds. Kept in one place so the framing function stays pure.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip_preserves_arbitrary_bytes() {
        // ADR-10: the payload is bytes, not text. 0x00, 0xFF and a truncated
        // UTF-8 sequence must all survive.
        let cases: Vec<Vec<u8>> = vec![
            b"hello".to_vec(),
            vec![0x00],
            vec![0xFF, 0xFE],
            vec![0xE2, 0x82], // first two bytes of a 3-byte char
            vec![0x00, 0xFF, 0x80, 0x7F],
        ];

        for bytes in cases {
            let frame = frame_pty_output("t1", &bytes, 1_700_000_000_000);
            let decoded = decode_pty_input(&frame).unwrap().unwrap();
            assert_eq!(decoded, bytes, "round trip changed the bytes");
        }
    }

    #[test]
    fn chunk_boundaries() {
        // Empty, exactly the chunk, and one over (two frames from the reader).
        for len in [0usize, MAX_PTY_CHUNK, MAX_PTY_CHUNK + 1] {
            let bytes = vec![0x41u8; len];
            let frame = frame_pty_output("t1", &bytes, 0);
            assert_eq!(decode_pty_input(&frame).unwrap().unwrap().len(), len);
        }

        // A frame above MAX_FRAME_BYTES is rejected before parsing.
        let oversize = "x".repeat(MAX_FRAME_BYTES + 1);
        assert!(decode_pty_input(&oversize).is_err());
    }

    #[test]
    fn resize_message_round_trip() {
        let raw = serde_json::json!({
            "type": "terminal-resize",
            "channel": "terminal",
            "payload": {
                "terminalId": "t1",
                "cols": 120,
                "rows": 40
            },
            "timestamp": 123456
        })
        .to_string();

        let envelope: DataChannelMessage<TerminalResizeMessage> =
            serde_json::from_str(&raw).unwrap();
        assert_eq!(envelope.r#type, "terminal-resize");
        assert_eq!(envelope.payload.terminal_id, "t1");
        assert_eq!(envelope.payload.cols, 120);
        assert_eq!(envelope.payload.rows, 40);
    }

    #[test]
    fn frame_pty_exit_produces_valid_envelope() {
        let frame = frame_pty_exit("t1", Some(0), 123456);
        let envelope: DataChannelMessage<TerminalExitMessage> =
            serde_json::from_str(&frame).unwrap();
        assert_eq!(envelope.r#type, "terminal-exit");
        assert_eq!(envelope.payload.terminal_id, "t1");
        assert_eq!(envelope.payload.exit_code, Some(0));
    }

    #[test]
    fn ignores_a_foreign_channel() {
        let frame = serde_json::json!({
            "type": "terminal-data",
            "channel": "desktop",
            "payload": { "terminalId": "t1", "data": "" },
            "timestamp": 0,
        })
        .to_string();
        assert_eq!(decode_pty_input(&frame).unwrap(), None);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn pty_echo_round_trip() {
        // The Week 5 roadmap line "Tích hợp portable-pty" verified end to end:
        // a real shell, a real PTY, real output.
        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(64);
        let session = PtySession::spawn("sh", 80, 24, input_rx).unwrap();

        // `echo hello` then exit. The reader sees EOF when the child exits and
        // the slave is closed — which is exactly why `drop(pair.slave)` matters.
        let mut cmd_bytes = b"echo hello\n".to_vec();
        cmd_bytes.extend_from_slice(b"exit\n");
        // `.send().await`, NOT `blocking_send`: tokio's `blocking_send` panics
        // when called from inside a runtime, and a `#[tokio::test]` body is one.
        input_tx.send(cmd_bytes).await.expect("writer thread");

        let mut frames = session.start_reader("t1".to_string()).unwrap();

        // A 10 s watchdog: a regression in `drop(pair.slave)` hangs the reader
        // forever, and a hung test must fail with a message, not block CI. Do
        // not replace this with an unbounded `recv()`.
        let collected = tokio::time::timeout(Duration::from_secs(10), async {
            let mut out: Vec<u8> = Vec::new();
            while let Some(frame) = frames.recv().await {
                let bytes = match frame {
                    Outbound::TerminalData { bytes, .. } => bytes,
                    Outbound::Json(s) => {
                        // A terminal-error or terminal-exit frame: skip for echo.
                        let _ = s;
                        continue;
                    }
                };
                out.extend_from_slice(&bytes);
                if String::from_utf8_lossy(&out).contains("hello") {
                    return out;
                }
            }
            out
        })
        .await
        .expect("PTY echo did not arrive within 10s");

        // `from_utf8_lossy` on the assertion only: the pump never assumes
        // UTF-8, but `echo hello` is ASCII and the assertion should be readable.
        assert!(
            String::from_utf8_lossy(&collected).contains("hello"),
            "expected echo output, got {:?}",
            String::from_utf8_lossy(&collected),
        );
    }

    #[test]
    fn terminal_error_frame_names_the_failure_and_the_terminal() {
        // A PTY that cannot be spawned is currently a `tracing::warn!` on the
        // agent and nothing at all in the browser: the user sees a terminal
        // that opened and stays blank forever. This frame is the only channel
        // by which the agent can tell the browser that.
        let frame = frame_pty_error(
            "t1",
            PtyErrorCode::SpawnFailed,
            "no such shell: /nope",
            1_700_000_000_000,
        );
        let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(value["type"], "terminal-error");
        assert_eq!(value["channel"], "terminal");
        assert_eq!(value["payload"]["terminalId"], "t1");
        assert_eq!(value["payload"]["code"], "pty-spawn-failed");
        assert_eq!(value["payload"]["message"], "no such shell: /nope");
    }

    #[test]
    fn every_pty_error_code_has_the_kebab_case_wire_spelling() {
        // The browser switches on these strings, so the spellings are a wire
        // contract. A rename here is a breaking change nobody would notice.
        let pairs = [
            (PtyErrorCode::SpawnFailed, "pty-spawn-failed"),
            (PtyErrorCode::SessionLimitReached, "session-limit-reached"),
        ];
        for (code, wire) in pairs {
            assert_eq!(code.as_str(), wire);
        }
    }

    #[test]
    fn plaintext_frame_is_byte_identical_to_today() {
        // The wire shape is the NESTED DataChannelMessage envelope
        // (`{type, channel, payload:{terminalId,data}, timestamp}`), matching
        // `frame_pty_output` in pty.rs:104-112. `build_terminal_data_frame` must
        // reproduce it byte-for-byte so the plaintext path is unchanged.
        let frame = build_terminal_data_frame("t1", b"hello world", 123);
        let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(v["type"], "terminal-data");
        assert_eq!(v["channel"], "terminal");
        assert_eq!(v["payload"]["terminalId"], "t1");
        assert_eq!(v["payload"]["data"], "aGVsbG8gd29ybGQ=");
        assert_eq!(v["timestamp"], 123);
    }

    #[test]
    fn frame_pty_output_delegates_to_build_terminal_data_frame() {
        // The refactored plaintext path must produce the same JSON as the new
        // shared builder, so the two entry points cannot drift.
        let a = frame_pty_output("t1", b"hello world", 123);
        let b = build_terminal_data_frame("t1", b"hello world", 123);
        assert_eq!(a, b);
    }

    #[test]
    fn outbound_terminal_data_carries_raw_bytes() {
        let o = Outbound::TerminalData {
            terminal_id: "t1".into(),
            bytes: b"x".to_vec(),
            timestamp_ms: 5,
        };
        match o {
            Outbound::TerminalData { bytes, .. } => assert_eq!(bytes, b"x"),
            _ => panic!("wrong variant"),
        }
    }
}

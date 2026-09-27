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

/// Encode raw PTY bytes as a `terminal-data` frame.
///
/// `timestamp` is passed in rather than read from the clock here so the framing
/// function stays pure and testable.
pub fn frame_pty_output(terminal_id: &str, bytes: &[u8], timestamp_ms: i64) -> String {
    let message = DataChannelMessage {
        r#type: "terminal-data".to_string(),
        channel: "terminal".to_string(),
        payload: TerminalDataMessage {
            terminal_id: terminal_id.to_string(),
            data: STANDARD.encode(bytes),
        },
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("a frame of strings cannot fail to serialize")
}

/// Decode an inbound `terminal-data` frame.
///
/// Returns `Ok(None)` when the frame is not a `terminal-data` frame on the
/// `terminal` channel (the agent ignores any other channel, per ADR-09) and
/// `Err` when it is but cannot be decoded. Strict, padded standard alphabet
/// (spec R16): a lenient decode would silently accept a frame the browser
/// never meant to send.
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
        .context("payload.data is not valid base64")?;

    Ok(Some(bytes))
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
    pub fn start_reader(&self, terminal_id: String) -> Result<mpsc::Receiver<String>> {
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

        let (frame_tx, frame_rx) = mpsc::channel::<String>(64);
        tokio::spawn(async move {
            while let Some(bytes) = raw_rx.recv().await {
                let frame = frame_pty_output(&terminal_id, &bytes, now_ms());
                if frame_tx.send(frame).await.is_err() {
                    break; // caller dropped the receiver
                }
            }
        });

        Ok(frame_rx)
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
                if let Ok(Some(bytes)) = decode_pty_input(&frame) {
                    out.extend_from_slice(&bytes);
                    if String::from_utf8_lossy(&out).contains("hello") {
                        return out;
                    }
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
}

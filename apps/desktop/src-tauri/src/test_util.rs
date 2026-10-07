//! Shared `#[cfg(test)]`-gated test helpers.
//!
//! (I-note, Task 6.) `spawn_stub` previously existed as an inline copy in both
//! `login.rs` and `wizard.rs`. A third copy in `devices.rs` would trip
//! SonarCloud new-code duplication (the Week 13/16 gotcha). This module
//! centralizes the stub + provider helpers so all three test modules share one
//! copy. Declared `#[cfg(test)] mod test_util;` from `lib.rs`.

use std::io::{Read, Write};
use std::thread;

/// Install the ring rustls crypto provider if not already installed. Safe to
/// call repeatedly; the second call returns `Err` (already installed) and is
/// ignored. Mirrors the local `ensure_provider()` shims in the older test mods.
pub fn ensure_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Spin up a tiny HTTP/1.1 stub server on an ephemeral port that returns
/// `canned_status`/`canned_body` for requests. Returns the bound
/// `http://127.0.0.1:port` URL. The server reads the request header block
/// (up to and including `\r\n\r\n`) and ignores any body, then writes the
/// canned response with `Connection: close` so the client knows the response
/// is complete.
pub fn spawn_stub(canned_status: u16, canned_body: String) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();

    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) => break, // client closed
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            // Respond regardless of how much of the body we read.
            let body = canned_body.clone();
            let resp = format!(
                "HTTP/1.1 {status} OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
                status = canned_status,
                len = body.len(),
                body = body,
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });

    format!("http://{addr}")
}

/// Like `spawn_stub` but also captures the request line (first line) and hands
/// it back via a channel receiver, so a test can assert which path the client
/// requested. Returns `(base_url, receiver)`.
///
/// Shared test utility; not every test module exercises it — `#[expect]` silences
/// the dead-code gate while keeping it available for new tests that need path
/// inspection.
#[expect(dead_code)]
pub fn spawn_stub_capturing(
    canned_status: u16,
    canned_body: String,
) -> (String, std::sync::mpsc::Receiver<String>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();

    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }

            // Extract the request line (first line up to \r\n).
            if let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                let line = buf[..nl].to_vec();
                let _ = tx.send(String::from_utf8_lossy(&line).to_string());
            }

            let body = canned_body.clone();
            let resp = format!(
                "HTTP/1.1 {status} OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
                status = canned_status,
                len = body.len(),
                body = body,
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });

    (format!("http://{addr}"), rx)
}

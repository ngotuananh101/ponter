//! WebSocket signaling client: handshake, inbound queue, outbound channel,
//! 30 s ping, and reconnect backoff.
//!
//! The types below mirror `packages/shared/src/types/signaling.ts` by hand.
//! They are the interop contract, so the serde attributes are load-bearing and
//! a round-trip test pins them (`offer_round_trip`, Step 8).

use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{Bytes, Message};

/// Mirrors the `SignalMessage` union in `packages/shared/src/types/signaling.ts`.
///
/// `#[serde(tag = "type", content = "data")]` is the whole interop contract: it
/// is byte-for-byte what `RESTPollingTransport.parseSignalItem` produces and
/// consumes (`packages/webrtc-core/src/transport.ts:182-218`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data", rename_all = "kebab-case")]
pub enum SignalMessage {
    Offer(SignalOffer),
    Answer(SignalAnswer),
    #[serde(rename = "ice-candidate")]
    IceCandidate(IceCandidateSignal),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IdentityProof {
    pub signature: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignalOffer {
    pub session_id: String,
    pub sdp: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub proof: Option<IdentityProof>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignalAnswer {
    pub session_id: String,
    pub sdp: String,
    pub approved: bool,
    #[serde(default)]
    pub proof: Option<IdentityProof>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IceCandidateSignal {
    pub session_id: String,
    pub candidate: String,
    pub sdp_mid: Option<String>,
    /// Wire type is `number | null`; narrowed to `u16` at the `rtc.rs` boundary
    /// (spec R7). `i32` here because a hostile peer can send `-1` or `70000`
    /// and serde must be able to *parse* it in order for the narrowing check to
    /// reject it with a useful error rather than a deserialize failure.
    ///
    /// Explicit `#[serde(rename = "sdpMLineIndex")]`: serde's `camelCase` rule
    /// produces `sdpMlineIndex` (lowercase `l`), but the TypeScript type on the
    /// wire is `sdpMLineIndex` (uppercase `M` — `sdpMid`/`sdpMLineIndex` are
    /// both capitalised, a WebRTC spec idiosyncrasy). The rename is the interop
    /// contract with `packages/shared/src/types/signaling.ts`.
    #[serde(rename = "sdpMLineIndex")]
    pub sdp_mline_index: Option<i32>,
}

/// The outermost WS envelope. A signal frame nests `{ type, data }` inside
/// `{ type: 'signal', data }`: the outer `type` is the transport discriminator
/// (matching `AgentSocketMessage` in `packages/shared`), the inner one is the
/// signal discriminator. `ping`/`pong`/`error` are transport frames.
///
/// `hello` is deliberately absent — see D-2 in the Week 5 plan. The Worker's
/// `handleInbound` has no arm for it and would answer `VALIDATION_ERROR`.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum InboundFrame {
    Signal { data: SignalMessage },
    Pong,
    Error { code: String },
}

/// The liveness and backoff constants, mirrored from
/// `packages/webrtc-core/src/transport.ts:45-46` (`initialIntervalMs`,
/// `maxIntervalMs`) and the `* 1.5` / `Math.min(.., maxIntervalMs)` at
/// `:140-143`, `:165-168`, `:171-174`.
pub const PING_INTERVAL: Duration = Duration::from_secs(30);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(90); // 3 missed pings
pub const BACKOFF_INITIAL: Duration = Duration::from_millis(200);
pub const BACKOFF_MAX: Duration = Duration::from_millis(2000);
pub const BACKOFF_FACTOR: f64 = 1.5;

/// The next reconnect delay: `min(delay * 1.5, BACKOFF_MAX)`.
///
/// The accumulator is `f64` and the result is rounded, because the TypeScript
/// sequence is `200, 300, 450, 675, 1012.5, …` and `Duration::from_millis`
/// takes an integer. The parity test asserts the factor, the initial value, the
/// cap and the reset rule — **not** the fractional milliseconds, which would be
/// a brittle cross-language assertion (spec §5.5.4).
pub fn next_backoff(current: Duration) -> Duration {
    let scaled = (current.as_secs_f64() * BACKOFF_FACTOR) * 1000.0;
    let capped = scaled.min(BACKOFF_MAX.as_millis() as f64);
    Duration::from_millis(capped.round() as u64)
}

/// Parse one inbound text frame.
///
/// Returns `Ok(None)` for a frame this client has no use for (a `pong`, an
/// error frame, or a control frame it does not implement) and `Err` for a frame
/// it cannot decode. The caller logs and drops an `Err` rather than panicking:
/// the body is attacker-influenced JSON, and a dropped malformed frame is
/// strictly better than a dead agent — the same rule as Week 4's
/// `parseSignalItem` guard.
pub fn parse_inbound(raw: &str) -> Result<Option<SignalMessage>> {
    if raw.len() > MAX_INBOUND_FRAME_BYTES {
        bail!("inbound frame exceeds {MAX_INBOUND_FRAME_BYTES} bytes");
    }
    match serde_json::from_str::<InboundFrame>(raw) {
        Ok(InboundFrame::Signal { data }) => Ok(Some(data)),
        Ok(InboundFrame::Pong) => Ok(None),
        Ok(InboundFrame::Error { code }) => {
            tracing::warn!(code = %code, "server sent an error frame");
            Ok(None)
        }
        Err(e) => Err(e).context("malformed inbound frame"),
    }
}

/// One ICE server entry, mirroring `IceServerConfig` in
/// `packages/shared/src/types/webrtc.ts`.
///
/// `urls` is a list because the server advertises a TURN entry as two URLs
/// (UDP and TCP transports) under one credential pair.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IceServerEntry {
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

/// The payload of the `ice-servers` frame.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IceServersPayload {
    #[serde(default)]
    ice_servers: Vec<IceServerEntry>,
}

/// The `ice-servers` frame, pushed by the server on connect.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum IceServersFrame {
    IceServers { data: IceServersPayload },
}

/// Parse the `ice-servers` frame the server pushes when the agent connects.
///
/// Returns `Ok(None)` for any frame that is not an `ice-servers` frame, so the
/// caller can fall through to `parse_inbound` for signaling. Kept separate
/// rather than folded into `parse_inbound` because that function's
/// `SignalMessage` return type is the RTC task's queue, and ICE configuration
/// is not a signal.
pub fn parse_ice_servers(raw: &str) -> Result<Option<Vec<IceServerEntry>>> {
    if raw.len() > MAX_INBOUND_FRAME_BYTES {
        bail!("inbound frame exceeds {MAX_INBOUND_FRAME_BYTES} bytes");
    }
    match serde_json::from_str::<IceServersFrame>(raw) {
        Ok(IceServersFrame::IceServers { data }) => Ok(Some(data.ice_servers)),
        Err(_) => Ok(None),
    }
}

/// Inbound frame cap, matching the Worker's `MAX_INBOUND_FRAME_BYTES`
/// (Task 4). Checked before `serde_json` so a hostile peer cannot make the
/// agent allocate an object graph proportional to the frame.
pub const MAX_INBOUND_FRAME_BYTES: usize = 256 * 1024;

/// The outbound envelope, mirroring `AgentSocketMessage` in `packages/shared`.
///
/// `#[serde(tag = "type")]` on a struct variant with one field produces
/// `{"type":"signal","data":{...}}` — the same shape Task 4's `pushToAgent`
/// sends, so the Rust client needs one arm for a push and an echo.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Envelope<'a> {
    Signal { data: &'a SignalMessage },
}

/// A connected agent socket.
pub struct SignalClient {
    sink: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    stream: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    inbound_tx: mpsc::Sender<SignalMessage>,
    /// The `ice-servers` frame the server pushes on connect, forwarded to the
    /// RTC task. Capacity 1 and it is written exactly once per connection, so
    /// a `try_send` that reports full is a real duplicate frame.
    ice_tx: mpsc::Sender<Vec<IceServerEntry>>,
}

impl SignalClient {
    /// Connect and authenticate. The credential travels in the
    /// `Authorization` header and **never** in the query string: a URL is
    /// logged by every proxy and by Cloudflare's own request log, and the
    /// credential is the one secret that must never appear in one (ADR-13).
    ///
    /// The inbound/ICE senders are **passed in**, not created here, because
    /// they belong to the connection-independent session machinery: the
    /// supervisor owns the receivers and must keep them across a reconnect, so
    /// the channels are created once in `run_with_reconnect` and only the
    /// socket is rebuilt per attempt. The outbound receiver is likewise owned by
    /// the caller and lent to [`run`].
    pub async fn connect(
        url: &str,
        credential: &str,
        inbound_tx: mpsc::Sender<SignalMessage>,
        ice_tx: mpsc::Sender<Vec<IceServerEntry>>,
    ) -> Result<Self> {
        let mut request = url.into_client_request().context("invalid signaling URL")?;
        request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {credential}"))
                .context("credential is not a valid header value")?,
        );

        let (ws, _response) = tokio_tungstenite::connect_async(request)
            .await
            .context("websocket handshake failed")?;

        let (sink, stream) = ws.split();

        Ok(Self {
            sink,
            stream,
            inbound_tx,
            ice_tx,
        })
    }

    /// Read + write + ping loop. Returns `Ok(())` on a clean close and `Err` on
    /// a fatal condition; the supervisor in `main.rs` decides whether that is a
    /// reconnect or an exit.
    ///
    /// `outbound_rx` is **borrowed**, not consumed, and belongs to the caller
    /// across reconnects: the session task keeps its `outbound_tx`, and the
    /// next socket's `run()` resumes draining the same channel. An answer or a
    /// candidate produced during a disconnect is therefore delivered on
    /// whichever socket is current instead of being stranded in a channel whose
    /// only reader just died. The inbound side needs no such treatment — the
    /// caller owns that receiver, so a fresh socket's `run()` resumes writing
    /// to the same queue.
    pub async fn run(&mut self, outbound_rx: &mut mpsc::Receiver<SignalMessage>) -> Result<()> {
        let mut ping = tokio::time::interval(PING_INTERVAL);
        // Skip the immediate first tick: connecting already wrote `is_online`,
        // and a ping at t=0 is noise.
        ping.tick().await;

        loop {
            tokio::select! {
                // Outbound signal from rtc.rs.
                Some(message) = outbound_rx.recv() => {
                    let text = serde_json::to_string(&Envelope::Signal { data: &message })?;
                    // `.into()`: tungstenite 0.26's `Message::Text` holds a
                    // `Utf8Bytes`, not a `String`.
                    self.sink.send(Message::Text(text.into())).await
                        .context("outbound send failed")?;
                }

                // Keepalive. The flush is NOT optional: tungstenite queues the
                // automatic pong reply to an inbound ping but does not flush it
                // (spec R15), so without a periodic flush the pong sits in the
                // buffer and the peer sees a dead socket.
                _ = ping.tick() => {
                    self.sink.send(Message::Text(r#"{"type":"ping"}"#.into())).await
                        .context("ping send failed")?;
                    self.sink.send(Message::Ping(Bytes::new())).await
                        .context("ping failed")?;
                    self.sink.flush().await.context("flush failed")?;
                }

                // Inbound. `IDLE_TIMEOUT` is a real liveness check, not a
                // constant kept for the docs: the server treats a ping older
                // than 90 s as a dead socket, so a socket that has been silent
                // for 90 s is one the server has already forgotten. Returning
                // `Err` hands it to the reconnect loop in `main.rs` instead of
                // sitting on a connection that can never deliver anything.
                frame = tokio::time::timeout(IDLE_TIMEOUT, self.stream.next()) => {
                    let frame = match frame {
                        Ok(frame) => frame,
                        Err(_) => bail!("no frame from the server in {IDLE_TIMEOUT:?}"),
                    };
                    let Some(frame) = frame else { return Ok(()) };  // clean close
                    match frame.context("inbound read failed")? {
                        Message::Text(text) => {
                            // The pushed ICE configuration is not a signal, so
                            // it is matched first: `parse_inbound` would drop it
                            // and the agent would build its peer with no TURN.
                            match parse_ice_servers(&text) {
                                Ok(Some(entries)) => {
                                    // A duplicate push is not fatal — the first
                                    // one already configured the peer.
                                    if self.ice_tx.try_send(entries).is_err() {
                                        tracing::debug!("ignoring a duplicate ice-servers frame");
                                    }
                                }
                                Ok(None) => match parse_inbound(&text) {
                                    Ok(Some(message)) => {
                                        // A full inbound queue means the RTC task is
                                        // wedged; dropping is correct (the Worker's
                                        // D1 row is the delivery guarantee).
                                        let _ = self.inbound_tx.try_send(message);
                                    }
                                    Ok(None) => {}
                                    Err(e) => {
                                        // Never log the body: an SDP is
                                        // session-identifying.
                                        tracing::warn!(
                                            error = %e,
                                            bytes = text.len(),
                                            "dropping malformed inbound frame",
                                        );
                                    }
                                },
                                Err(e) => {
                                    tracing::warn!(
                                        error = %e,
                                        bytes = text.len(),
                                        "dropping oversize inbound frame",
                                    );
                                }
                            }
                        }
                        // The protocol is text-only. A binary frame is ignored
                        // without a reply.
                        Message::Binary(_) => {}
                        Message::Ping(payload) => {
                            self.sink.send(Message::Pong(payload)).await
                                .context("pong failed")?;
                        }
                        Message::Pong(_) => {}
                        Message::Close(_) => return Ok(()),
                        // `Frame` is feature-gated in tungstenite, so a
                        // catch-all keeps this exhaustive either way.
                        _ => {}
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offer_round_trip() {
        // The wire shape is the interop contract: `type`/`data` at the top,
        // camelCase inside. Re-serializing must reproduce both.
        let raw =
            r#"{"type":"offer","data":{"sessionId":"s1","sdp":"v=0","capabilities":["terminal"]}}"#;
        let parsed = serde_json::from_str::<SignalMessage>(raw).unwrap();
        let SignalMessage::Offer(offer) = &parsed else {
            panic!("expected an offer, got {parsed:?}");
        };
        assert_eq!(offer.session_id, "s1");
        assert_eq!(offer.capabilities, vec!["terminal".to_string()]);

        let re = serde_json::to_string(&parsed).unwrap();
        let value: serde_json::Value = serde_json::from_str(&re).unwrap();
        assert_eq!(value["type"], "offer");
        assert_eq!(value["data"]["sessionId"], "s1");
        assert!(
            value["data"].get("session_id").is_none(),
            "must be camelCase"
        );
    }

    #[test]
    fn rejects_malformed() {
        // Every one of these must be an Err, never a panic: the body is
        // attacker-influenced JSON.
        for raw in [
            r#"{"type":"unknown","data":{}}"#,
            r#"{"type":"signal"}"#,
            r#"{"type":"offer","data":{"sessionId":"s1"}}"#,
            r#"null"#,
            r#"[]"#,
            r#"not json at all"#,
        ] {
            assert!(parse_inbound(raw).is_err(), "should reject {raw}");
        }
    }

    #[test]
    fn backoff_sequence() {
        // Mirrors the TS sequence's factor, initial value, cap and reset rule —
        // not the fractional milliseconds (spec §5.5.4).
        let mut d = BACKOFF_INITIAL;
        let mut seen = vec![d.as_millis() as u64];
        for _ in 0..8 {
            d = next_backoff(d);
            seen.push(d.as_millis() as u64);
        }
        assert_eq!(&seen[..4], &[200, 300, 450, 675]);
        assert_eq!(*seen.last().unwrap(), 2000, "must cap at BACKOFF_MAX");

        // Reset-on-activity: the supervisor reassigns BACKOFF_INITIAL, so the
        // rule under test is that the constant is the floor.
        assert_eq!(BACKOFF_INITIAL.as_millis() as u64, 200);
    }

    #[test]
    fn keepalive_window_is_three_missed_pings() {
        // The two constants are one decision: the server treats a ping older
        // than 90 s as a dead socket (Task 5's `ONLINE_WINDOW_SECONDS`), so a
        // 30 s interval tolerates exactly two dropped pings before the agent
        // reads as offline. Pinning the ratio means changing either value
        // without the other fails here rather than in production.
        assert_eq!(PING_INTERVAL.as_secs() * 3, IDLE_TIMEOUT.as_secs());
        assert_eq!(IDLE_TIMEOUT.as_secs(), 90);
    }

    #[test]
    fn oversize_frame_is_rejected_before_parsing() {
        let huge = "x".repeat(MAX_INBOUND_FRAME_BYTES + 1);
        assert!(parse_inbound(&huge).is_err());
    }

    #[test]
    fn parses_the_pushed_ice_servers_frame() {
        // The server pushes this on connect because the agent cannot call
        // `GET /api/webrtc/ice-servers` (that route authenticates a user JWT,
        // while this socket is authenticated by the agent credential).
        let raw = r#"{"type":"ice-servers","data":{"iceServers":[{"urls":["stun:stun.example.com:19302"]},{"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"],"username":"1700000000:user-1","credential":"cred-abc"}]}}"#;

        let parsed = parse_ice_servers(raw).expect("frame must parse");
        let Some(entries) = parsed else {
            panic!("expected an ice-servers frame");
        };
        assert_eq!(entries.len(), 2);

        let stun = &entries[0];
        assert_eq!(stun.urls, vec!["stun:stun.example.com:19302".to_string()]);
        assert!(stun.username.is_none());
        assert!(stun.credential.is_none());

        let turn = &entries[1];
        assert_eq!(turn.urls.len(), 2);
        assert_eq!(turn.username.as_deref(), Some("1700000000:user-1"));
        assert_eq!(turn.credential.as_deref(), Some("cred-abc"));
    }

    #[test]
    fn parses_a_stun_only_ice_servers_frame() {
        // The no-TURN deployment pushes one STUN entry with the credential
        // fields absent, not empty strings.
        let raw = r#"{"type":"ice-servers","data":{"iceServers":[{"urls":["stun:stun.l.google.com:19302"]}]}}"#;

        let parsed = parse_ice_servers(raw).expect("frame must parse");
        let Some(entries) = parsed else {
            panic!("expected an ice-servers frame");
        };
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].urls,
            vec!["stun:stun.l.google.com:19302".to_string()]
        );
        assert!(entries[0].username.is_none());
    }

    #[test]
    fn carries_an_identity_proof() {
        let raw = r#"{"type":"answer","data":{"sessionId":"s1","sdp":"v=0","approved":true,"proof":{"signature":"c2ln","fingerprint":"AB:CD"}}}"#;
        let parsed: SignalMessage = serde_json::from_str(raw).unwrap();
        let SignalMessage::Answer(a) = parsed else { panic!("expected answer") };
        assert_eq!(a.proof.unwrap().fingerprint, "AB:CD");
    }

    #[test]
    fn proof_is_optional_for_backward_shapes() {
        let raw = r#"{"type":"offer","data":{"sessionId":"s1","sdp":"v=0","capabilities":[]}}"#;
        let parsed: SignalMessage = serde_json::from_str(raw).unwrap();
        let SignalMessage::Offer(o) = parsed else { panic!("expected offer") };
        assert!(o.proof.is_none());
    }

    #[test]
    fn an_ice_servers_frame_is_not_taken_as_one() {
        // A control frame must not be mistaken for ICE configuration, and
        // `parse_inbound` must still return `None` for it rather than
        // feeding the RTC task something that is not a signal.
        assert!(parse_ice_servers(r#"{"type":"pong"}"#)
            .expect("pong parses")
            .is_none());
        assert!(parse_inbound(r#"{"type":"pong"}"#)
            .expect("pong parses")
            .is_none());
    }
}

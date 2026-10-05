//! WebRTC answerer. Owns one `PeerConnection` for one session.
//!
//! The crate here is webrtc 0.21, a sans-IO rewrite: the connection is built
//! by [`PeerConnectionBuilder`] and driven by a background driver task, and
//! every callback arrives on a [`PeerConnectionEventHandler`] that must be
//! handed to the builder **before** `build()` — `build()` fails with
//! "no event handler found" otherwise. There is no `on_*` registration API on
//! the connection itself any more.

use std::sync::atomic::AtomicU64;
#[cfg(not(target_env = "musl"))]
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result};
use rtc::ice::mdns::MulticastDnsMode;
use rtc::peer_connection::transport::RTCDtlsRole;
use tokio::sync::{mpsc, oneshot};
use webrtc::data_channel::DataChannel;
#[cfg(not(target_env = "musl"))]
use webrtc::peer_connection::{configure_congestion_control, CongestionFeedback};
use webrtc::peer_connection::{
    register_default_interceptors, MediaEngine, PeerConnection, PeerConnectionBuilder,
    PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceCandidateInit, RTCIceServer,
    RTCPeerConnectionIceEvent, RTCPeerConnectionState, RTCSessionDescription, Registry,
    SettingEngineBuilder,
};

#[cfg(not(target_env = "musl"))]
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[cfg(not(target_env = "musl"))]
use rtc::media_stream::MediaStreamTrack;
#[cfg(not(target_env = "musl"))]
use rtc::peer_connection::configuration::media_engine::MIME_TYPE_H264;
#[cfg(not(target_env = "musl"))]
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
    RtpCodecKind,
};
#[cfg(not(target_env = "musl"))]
use rtc::rtp_transceiver::{PayloadType, SSRC};
#[cfg(not(target_env = "musl"))]
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
#[cfg(not(target_env = "musl"))]
use webrtc::media_stream::track_local::TrackLocal;
#[cfg(not(target_env = "musl"))]
use webrtc::media_stream::Track;
#[cfg(not(target_env = "musl"))]
use webrtc::rtp_transceiver::RtpSender;

use crate::signal::{IceCandidateSignal, IceServerEntry, SignalAnswer, SignalMessage, SignalOffer};

/// The one channel label this agent accepts. ADR-09: exact label, nothing else.
pub const TERMINAL_LABEL: &str = "terminal";

/// The desktop control channel's label (Week 8, spec §2.1). Desktop-only.
pub const CONTROL_LABEL: &str = "control";

/// The capability string that selects a desktop session (ADR-15).
pub const DESKTOP_LABEL: &str = "desktop";

/// The file transfer channel's label (Week 10, ADR-31). A files session is a
/// data-channel session like the terminal, served over exactly this label.
pub const FILES_LABEL: &str = "files";

/// Where GCC starts (spec §3.3). Deliberately low — the safe floor, not the
/// 1080p30 target — because a path that opens congested should not open at
/// 6 Mbps. The dispatcher ignores the estimate until it *moves off* this seed,
/// so the stream still starts at the session profile (spec §2.3 step 2).
#[cfg(not(target_env = "musl"))]
pub const ABR_INITIAL_BPS: f64 = 4_000_000.0;
/// Never let GCC drive the encoder outside the wire boundary's clamp.
#[cfg(not(target_env = "musl"))]
pub const ABR_MIN_BPS: f64 = 250_000.0;
#[cfg(not(target_env = "musl"))]
pub const ABR_MAX_BPS: f64 = 20_000_000.0;

/// GCC-driven auto-ABR (spec §3.3, ADR-23 PASS branch). Installed only on a
/// peer that carries a control channel, so the terminal SDP is untouched.
#[cfg(not(target_env = "musl"))]
mod abr {
    use rtc::interceptor::{BandwidthEstimator, EstimatorStats, Gcc, PacketReport};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    /// Delegates to `inner` and publishes its target after every update.
    ///
    /// `configure_congestion_control` boxes the estimator inside the chain, so
    /// this wrapper is the one application-supplied object in the loop that can
    /// carry the number back out (spec §3.3). Copied from the shipped example
    /// `webrtc-0.21.0/examples/bandwidth-estimation-from-disk`.
    pub struct ReportingEstimator<E: BandwidthEstimator> {
        inner: E,
        target: Arc<AtomicU64>,
    }

    impl<E: BandwidthEstimator> ReportingEstimator<E> {
        pub fn new(inner: E) -> (Self, Arc<AtomicU64>) {
            let target = Arc::new(AtomicU64::new(inner.target_bitrate().to_bits()));
            let handle = Arc::clone(&target);
            (Self { inner, target }, handle)
        }

        fn publish(&self) {
            self.target
                .store(self.inner.target_bitrate().to_bits(), Ordering::Relaxed);
        }
    }

    impl<E: BandwidthEstimator> BandwidthEstimator for ReportingEstimator<E> {
        fn on_reports(&mut self, now: Instant, reports: &[PacketReport]) {
            self.inner.on_reports(now, reports);
            self.publish();
        }

        fn target_bitrate(&self) -> f64 {
            self.inner.target_bitrate()
        }

        fn handle_timeout(&mut self, now: Instant) {
            self.inner.handle_timeout(now);
            self.publish();
        }

        fn poll_timeout(&self) -> Option<Instant> {
            self.inner.poll_timeout()
        }

        fn stats(&self) -> EstimatorStats {
            self.inner.stats()
        }
    }

    /// A GCC estimator wrapped so its target is observable.
    pub fn estimator() -> (ReportingEstimator<Gcc>, Arc<AtomicU64>) {
        ReportingEstimator::new(Gcc::new(
            super::ABR_INITIAL_BPS,
            super::ABR_MIN_BPS,
            super::ABR_MAX_BPS,
        ))
    }
}

/// A per-process counter so two sessions in one agent never share an SSRC.
#[cfg(not(target_env = "musl"))]
static SSRC_SEQUENCE: AtomicU32 = AtomicU32::new(0);

/// A session-local SSRC: process-start time XORed with a monotonic counter.
///
/// The value is not security-relevant (it only has to be unique per sender on
/// one connection), so this avoids adding a `rand` dependency: the nanosecond
/// clock gives cross-process spread, the counter makes collisions within one
/// process impossible, and `| 1` keeps the result non-zero.
#[cfg(not(target_env = "musl"))]
fn next_ssrc() -> SSRC {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = SSRC_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    ((nanos as u32) ^ ((nanos >> 32) as u32) ^ seq) | 1
}

/// The sending track plus the sender, so the session can resolve the
/// negotiated payload type and the SSRC after the answer is connected.
#[cfg(not(target_env = "musl"))]
pub struct DesktopMedia {
    pub track: Arc<TrackLocalStaticSample>,
    pub sender: Arc<dyn RtpSender>,
}

/// Build the video track and attach it to the peer.
///
/// **Must be called before `set_remote_description`.** `add_track` creates the
/// transceiver and its m-line; adding it after the remote description exists
/// means the offer's video m-line is answered `inactive` and the browser never
/// receives a track (ADR-15, and the E2E in Task 6 pins it).
///
/// The codec parameters mirror the `MediaEngine`'s default H.264 entry (PT 102,
/// `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f`).
/// The actual negotiated payload type is read back from the sender later — this
/// value only has to match the mime/fmtp the answer advertises so the offer's
/// H.264 m-line can be matched to it.
#[cfg(not(target_env = "musl"))]
pub async fn attach_desktop_track(peer: &Arc<dyn PeerConnection>) -> Result<DesktopMedia> {
    let ssrc = next_ssrc();
    let rtp_codec = RTCRtpCodec {
        mime_type: MIME_TYPE_H264.to_owned(),
        clock_rate: 90_000,
        channels: 0,
        sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"
            .to_owned(),
        rtcp_feedback: vec![],
    };

    let track = Arc::new(
        TrackLocalStaticSample::new(
            Instant::now(),
            MediaStreamTrack::new(
                "ponter-desktop".to_owned(),
                "screen".to_owned(),
                DESKTOP_LABEL.to_owned(),
                RtpCodecKind::Video,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters {
                        ssrc: Some(ssrc),
                        ..Default::default()
                    },
                    codec: rtp_codec,
                    ..Default::default()
                }],
            ),
        )
        .context("building the desktop track")?,
    );

    let sender = peer
        .add_track(Arc::clone(&track) as Arc<dyn TrackLocal>)
        .await
        .context("add_track(desktop)")?;

    Ok(DesktopMedia { track, sender })
}

/// Answer an offer with `approved: true` and the SDP just built.
///
/// The caller has already decided this offer is one it can serve (desktop
/// track attached, or a files root resolved), so the flag is fixed to `true`;
/// this is the same `set_remote_description → create_answer →
/// set_local_description → send` core as [`answer_offer`].
///
/// **Not cfg-gated**: `files.rs` is compiled on every target (spec §6.1), so
/// the files dispatch arm needs this on musl too. The desktop-named wrapper
/// below keeps its cfg.
pub async fn send_approved_answer(
    peer: &Arc<dyn PeerConnection>,
    offer: &SignalOffer,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    send_answer(peer, offer, true, outbound).await
}

/// Answer a desktop offer with `approved: true` and the SDP just built.
///
/// The track is attached by the caller *before* this runs (ADR-15). Kept as
/// the desktop-specific name; delegates to [`send_approved_answer`] so the
/// desktop and files approved paths cannot drift.
#[cfg(not(target_env = "musl"))]
pub async fn send_desktop_answer(
    peer: &Arc<dyn PeerConnection>,
    offer: &SignalOffer,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    send_approved_answer(peer, offer, outbound).await
}

/// Picks the payload type the desktop stream must be stamped with.
///
/// **Not `codecs.first()`.** rtc's
/// `set_codec_preferences_from_remote_description` rebuilds the sender's codec
/// list in the *offer's* m-line order, so the first entry is whatever the
/// browser offered first — and a real Chrome offer lists VP8 (PT 96) before
/// H.264 (PT 102). The track only ever emits H.264, so taking `.first()` stamped
/// every RTP packet with VP8's PT 96 while carrying an H.264 payload: Chrome
/// demuxes by payload type, routed the packets to its VP8 decoder, failed, and
/// rendered a black frame with the connection otherwise healthy. werift (the CI
/// E2E peer) offers H.264 only, so its `.first()` was already H.264 and the bug
/// never surfaced there.
///
/// Split out from [`desktop_stream_params`] so the selection is unit-testable
/// without a peer connection.
#[cfg(not(target_env = "musl"))]
fn select_h264_payload_type(codecs: &[RTCRtpCodecParameters]) -> Option<PayloadType> {
    codecs
        .iter()
        .find(|codec| {
            codec
                .rtp_codec
                .mime_type
                .eq_ignore_ascii_case(MIME_TYPE_H264)
        })
        .map(|codec| codec.payload_type)
}

/// Resolve the negotiated payload type and SSRC for a desktop sender.
///
/// Neither is assumed: the payload type is whatever the SDP negotiation chose
/// (the offer may not have picked PT 102), and the SSRC is the one the track was
/// built with, read back through the track API. Both are needed by
/// `desktop::run_stream`, and a wrong payload type makes the browser drop or
/// mis-decode every packet.
#[cfg(not(target_env = "musl"))]
pub async fn desktop_stream_params(media: &DesktopMedia) -> Result<(SSRC, PayloadType)> {
    let payload_type = select_h264_payload_type(
        &media
            .sender
            .get_parameters()
            .await
            .context("sender.get_parameters")?
            .rtp_parameters
            .codecs,
    )
    .ok_or_else(|| anyhow::anyhow!("the desktop sender has no negotiated H.264 codec"))?;

    let ssrc = *media
        .track
        .ssrcs()
        .await
        .first()
        .ok_or_else(|| anyhow::anyhow!("the desktop track has no SSRC"))?;

    Ok((ssrc, payload_type))
}

/// Map the pushed `ice-servers` entries onto the crate's ICE server type.
///
/// `turn:` URLs carrying `transport=tcp` are dropped (see
/// [`is_unusable_turn_tcp`]), and an entry left with no URLs is dropped with
/// them — an ICE server with an empty URL list is not a server. The server
/// advertises both transports because browsers support TURN/TCP, so the agent
/// filters its own copy rather than asking the server to degrade the
/// browser's list.
///
/// An empty input means the server offered nothing, which is a valid
/// deployment (no TURN configured). The caller then keeps its own `--stun`
/// value rather than building a peer with no ICE server at all.
pub fn ice_servers_from_entries(entries: &[IceServerEntry]) -> Vec<RTCIceServer> {
    entries
        .iter()
        .filter_map(|entry| {
            let urls: Vec<String> = entry
                .urls
                .iter()
                .filter(|url| !is_unusable_turn_tcp(url))
                .cloned()
                .collect();
            if urls.is_empty() {
                return None;
            }
            Some(RTCIceServer {
                urls,
                username: entry.username.clone().unwrap_or_default(),
                credential: entry.credential.clone().unwrap_or_default(),
            })
        })
        .collect()
}

/// Whether this URL must be dropped before the crate sees it.
///
/// rtc 0.21's TURN relayer implements only TURN over UDP: a `turn:` URL with
/// `transport=tcp` is skipped with "Skipping unsupported non-UDP TURN url",
/// once per gather, and can never succeed. The server mints both transports
/// for the browser, which does support TURN/TCP, so the agent filters its own
/// copy instead.
///
/// This does **not** rescue a network where UDP is blocked: the crate has no
/// TURN/TCP client to fall back to. It only removes an attempt that could
/// never succeed and the warning it logs.
fn is_unusable_turn_tcp(url: &str) -> bool {
    url.starts_with("turn:") && url.contains("transport=tcp")
}

/// Build the peer connection.
///
/// mDNS is disabled: headless hosts and containers frequently have no mDNS
/// responder, and leaving it on produces unresolvable `.local` candidates.
///
/// **The loopback bind is load-bearing.** 0.13 had
/// `set_include_loopback_candidate(true)`; 0.21 has no such setting — a
/// wildcard address is expanded to one socket per usable interface and the
/// expansion *skips loopback*. So a wildcard-only bind produces no loopback
/// host candidate, and the E2E harness runs with `--stun ''` and
/// `iceServers: []` where the loopback candidate is the only way the
/// connection can complete. Binding `127.0.0.1:0` explicitly (it goes through
/// the non-wildcard path, which binds the address verbatim) restores it;
/// `0.0.0.0:0` keeps the LAN/STUN path working on real hosts.
///
/// `pushed` is the `ice-servers` frame the server sent when this agent
/// connected. It takes precedence over `stun_url` because it carries the
/// short-lived TURN credentials, and the server is the only party that can
/// mint them: the agent authenticates with its own credential and cannot call
/// `GET /api/webrtc/ice-servers`, which wants a user JWT. `stun_url` stays as
/// the fallback for a server that pushes nothing.
pub async fn build_peer(
    pushed: &[IceServerEntry],
    stun_url: &str,
    handler: Arc<dyn PeerConnectionEventHandler>,
    media_only: bool,
    has_control: bool,
) -> Result<BuiltPeer> {
    let mut media = MediaEngine::default();
    media
        .register_default_codecs()
        .context("register_default_codecs")?;

    // Congestion control is desktop-only: it registers `transport-cc` feedback
    // and a header extension on the media engine, which changes the SDP. The
    // terminal path must stay byte-identical (spec §2.4), so it is gated on
    // `has_control` — the same flag that decides the ICE timeouts below.
    #[cfg(not(target_env = "musl"))]
    let (registry, abr_target) = if has_control {
        let (estimator, handle) = abr::estimator();
        let registry = configure_congestion_control(
            Registry::new(),
            estimator,
            CongestionFeedback::Twcc,
            &mut media,
        )
        .context("configure_congestion_control")?;
        (registry, Some(handle))
    } else {
        (Registry::new(), None)
    };
    // musl has no desktop session, so `has_control` is never true there; the
    // peer still needs a registry, just without congestion control.
    #[cfg(target_env = "musl")]
    let (registry, abr_target): (Registry, Option<Arc<AtomicU64>>) = (Registry::new(), None);

    let registry = register_default_interceptors(registry, &mut media)
        .context("register_default_interceptors")?;

    let mut setting = SettingEngineBuilder::new()
        .with_multicast_dns_mode(MulticastDnsMode::Disabled)
        // The answerer must resolve `a=setup` to a concrete role, and the
        // choice decides who can answer an SCTP INIT. rtc 0.21 builds a
        // client-only SCTP endpoint when this side is the DTLS client: no
        // ServerConfig, so every incoming INIT is refused ("refusing first
        // packet due to empty server_config"), and the endpoint depends on its
        // own INIT being answered. The peer, though, may pick its SCTP role
        // from the ICE role rather than the DTLS role (werift: `isServer =
        // iceRole !== "controlling"`), so an ICE-controlling offerer that is
        // also the DTLS client still sends INIT — and with the default client
        // answer (`a=setup:active`) both endpoints send INIT and neither
        // answers: the session connects at ICE/DTLS and then hangs forever
        // waiting for a channel.
        //
        // 0.13 papered over this with SCTP simultaneous open (webrtc-sctp 0.12
        // answered an INIT even from COOKIE-WAIT); rtc 0.21 dropped it. The
        // answerer taking the DTLS server role (RFC 5763 §5 allows active or
        // passive) makes rtc build a server SCTP endpoint that accepts the
        // peer's INIT — and it matches the production topology: the browser is
        // the offerer, so Chrome and werift both initiate the association
        // while this side answers.
        .with_answering_dtls_role(RTCDtlsRole::Server);

    // A peer with a data channel — terminal's, or desktop's control channel —
    // treats a channel close as the end-of-session signal, so it keeps the
    // RFC-shaped ICE defaults. Only a peer with no channel at all relies on ICE
    // silence, and only that peer gets the shortened timeouts (spec §6.3).
    //
    // Week 7's rationale for the shortened timeouts still holds for that
    // no-channel case: werift's `pc.close()` on a connection with no SCTP
    // association sends neither a DTLS close_notify nor an ICE packet, it simply
    // stops. The defaults (disconnected 5s + failed 25s, per `rtc-ice`'s
    // `validate_selected_pair`) would hold the ADR-14 slot for ~30s after a
    // network drop — long enough that a user cannot reconnect, and long enough
    // that the E2E teardown assertion (20s) could never pass. Desktop media
    // flows every ~66ms, so 3s of silence is unambiguous; Failed at
    // 3s + 5s = 8s keeps a brief `Disconnected` recoverable while still freeing
    // the slot promptly. A peer with a channel does not need this: its channel
    // close is the prompt signal, so a short ICE timeout would only add false
    // failures on a healthy-but-quiet link.
    if media_only && !has_control {
        setting = setting.with_ice_timeouts(
            Some(Duration::from_secs(3)),
            Some(Duration::from_secs(5)),
            Some(Duration::from_secs(1)),
        );
    }
    let setting = setting.build();

    let mut ice_servers = ice_servers_from_entries(pushed);
    if ice_servers.is_empty() && !stun_url.is_empty() {
        ice_servers = vec![RTCIceServer {
            urls: vec![stun_url.to_string()],
            ..Default::default()
        }];
    }

    let config = RTCConfigurationBuilder::new()
        .with_ice_servers(ice_servers)
        .build();

    let peer = PeerConnectionBuilder::new()
        .with_configuration(config)
        .with_media_engine(media)
        .with_setting_engine(setting)
        .with_interceptor_registry(registry)
        .with_handler(handler)
        .with_udp_addrs(vec!["0.0.0.0:0".to_string(), "127.0.0.1:0".to_string()])
        .build()
        .await
        .context("build peer connection")?;

    Ok(BuiltPeer {
        peer: Arc::new(peer) as Arc<dyn PeerConnection>,
        abr_target,
    })
}

/// A built peer plus the handles the session needs from it.
///
/// `abr_target` is `Some` only for a peer built with congestion control — a
/// desktop session. The terminal and refusal peers leave it `None`, so their
/// SDP is byte-identical to Week 7 (spec §2.4).
pub struct BuiltPeer {
    pub peer: Arc<dyn PeerConnection>,
    pub abr_target: Option<Arc<AtomicU64>>,
}

/// The event handler every session peer is built with.
///
/// In 0.21 the callbacks are not registered on the connection after the fact:
/// the handler goes into the builder and `build()` refuses without one. It is
/// therefore created before the peer and holds the channels the session loop
/// reads.
pub struct SessionHandler {
    session_id: String,
    outbound: mpsc::Sender<SignalMessage>,
    end_tx: mpsc::Sender<&'static str>,
    /// The one channel label this session accepts (ADR-09): `terminal` for a
    /// terminal session, `control` for a desktop session.
    accepted_label: String,
    channel: Arc<OnceLock<Arc<dyn DataChannel>>>,
    open_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    /// Fired once on `Connected`. The desktop session waits on it; the terminal
    /// session ignores it (it waits for the data channel instead).
    connected_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

impl SessionHandler {
    pub fn new(
        session_id: String,
        outbound: mpsc::Sender<SignalMessage>,
        end_tx: mpsc::Sender<&'static str>,
        accepted_label: String,
        channel: Arc<OnceLock<Arc<dyn DataChannel>>>,
        open_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
        connected_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    ) -> Self {
        Self {
            session_id,
            outbound,
            end_tx,
            accepted_label,
            channel,
            open_tx,
            connected_tx,
        }
    }
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for SessionHandler {
    /// Forward one gathered candidate to the browser.
    ///
    /// The handler is attached by the builder before the offer is processed,
    /// which is what the old code achieved by registering before
    /// `set_local_description`: gathering starts the moment the local
    /// description is set, and a handler attached later would miss the host
    /// candidates emitted in that same tick.
    ///
    /// There is no gathering-complete case here any more: 0.21 does not
    /// deliver end-of-candidates through this callback (an empty candidate
    /// only moves the gathering state), so every event is a real candidate.
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        // `to_json` is the crate's bridge to the wire type: it produces the
        // `candidate:`-prefixed string and the `sdpMid`/`sdpMLineIndex` pair
        // the browser parses.
        let init = match event.candidate.to_json() {
            Ok(init) => prepare_outbound_candidate(init),
            Err(e) => {
                tracing::warn!(error = %e, "dropping an unmappable candidate");
                return;
            }
        };
        let signal = match candidate_to_wire(&self.session_id, init) {
            Ok(signal) => signal,
            Err(e) => {
                tracing::warn!(error = %e, "dropping an unmappable candidate");
                return;
            }
        };
        // Never block the driver here. This callback runs on the driver task,
        // which owns ICE consent and SCTP timers; the signaling socket can be
        // down for minutes (reconnect backoff) while `outbound` sits full, and
        // blocking would expire consent and drop a healthy session — the
        // failure the dead-peer fix exists to prevent. A spawned send is
        // best-effort like the Worker's push: a candidate that cannot be sent
        // is a lost candidate, not a dead session — ICE retries and one lost
        // candidate is rarely fatal.
        let outbound = self.outbound.clone();
        tokio::spawn(async move {
            if outbound
                .send(SignalMessage::IceCandidate(signal))
                .await
                .is_err()
            {
                tracing::debug!("outbound closed while sending a candidate");
            }
        });
    }

    /// Report `Connected`, and end the session on `Failed` or `Closed`.
    ///
    /// `Failed` is ICE giving up (a killed tab that never sent a close, a
    /// network cut). `Closed` is the peer closing cleanly — for a terminal
    /// session the data-channel close already covers that, but a desktop
    /// session has no data channel, so `Closed` is the only signal that the
    /// browser hung up. `Disconnected` is deliberately NOT terminal: it is
    /// transient and recovers on its own. `Connected` fires `connected_tx`
    /// exactly once (the `take()` makes a repeat a no-op).
    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        match state {
            RTCPeerConnectionState::Connected => {
                if let Some(tx) = self.connected_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
            RTCPeerConnectionState::Failed => {
                let _ = self.end_tx.try_send("the peer connection failed");
            }
            RTCPeerConnectionState::Closed => {
                let _ = self.end_tx.try_send("the peer connection closed");
            }
            _ => {}
        }
    }

    /// Accept the `terminal` channel and publish it to the session loop.
    ///
    /// ADR-09: the exact label, and nothing else. An unexpected channel is
    /// closed rather than ignored — leaving it half-open would let a peer keep
    /// a second channel alive past its welcome. A second `terminal` channel is
    /// closed for the same reason.
    ///
    /// The driver announces a channel exactly when it opens (it is the
    /// `OnOpen` event that creates this callback), so the channel is already
    /// open here. Messages and a close that arrive before the session loop
    /// starts polling are queued by the driver (capacity 256, retained under
    /// back-pressure), not lost.
    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        match dc.label().await {
            Ok(label) if label == self.accepted_label => {}
            Ok(label) => {
                tracing::warn!(label = %label, "refusing unexpected channel");
                let _ = dc.close().await;
                return;
            }
            Err(e) => {
                // A round-trip to the driver; it fails once the channel is
                // gone. Nothing left to refuse at that point.
                tracing::warn!(error = %e, "dropping an unlabelled channel");
                return;
            }
        }

        if let Err(second) = self.channel.set(dc) {
            tracing::warn!(label = %self.accepted_label, "refusing a second session channel");
            let _ = second.close().await;
            return;
        }
        // Set before firing: the session loop reads `channel` after `open_rx`
        // resolves, so the value must already be in place.
        if let Some(tx) = self.open_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }
}

/// A no-op handler for peers that never carry a session.
///
/// The ADR-14 refusal path builds a real peer to answer and immediately close
/// it; `build()` requires a handler, and none of the callbacks matter there.
pub struct NoopHandler;

#[async_trait::async_trait]
impl PeerConnectionEventHandler for NoopHandler {}

/// Narrow a wire `sdpMLineIndex` to the `u16` the crate uses.
///
/// Spec R7: a value outside `0..=65535` is rejected at the boundary rather than
/// truncated, because a truncated index makes the peer associate the candidate
/// with the wrong media section.
pub fn narrow_mline_index(raw: Option<i32>) -> Result<Option<u16>> {
    match raw {
        None => Ok(None),
        Some(v) if (0..=65535).contains(&v) => Ok(Some(v as u16)),
        Some(v) => anyhow::bail!("sdpMLineIndex {v} is outside 0..=65535"),
    }
}

/// Apply every buffered candidate, in arrival order, after the remote
/// description exists.
///
/// The buffering itself is the Week 4 F1 twin (spec R3): `add_ice_candidate`
/// returns `ErrNoRemoteDescription` when it is called too early, so a naive
/// implementation **loses** candidates and the connection fails with an
/// unhelpful error. Both peers must buffer or neither connects.
///
/// Called by `run_one_session` once `answer_offer` has set the remote
/// description; the buffer is filled by `apply_candidate`.
pub async fn flush_pending_candidates(
    peer: &Arc<dyn PeerConnection>,
    pending: &mut Vec<RTCIceCandidateInit>,
) -> Result<()> {
    for cand in pending.drain(..) {
        // Sequential, in arrival order.
        peer.add_ice_candidate(cand)
            .await
            .context("add_ice_candidate (flushed)")?;
    }
    Ok(())
}

/// Answer one offer: set the remote description, create the answer, send it.
///
/// **Candidate buffering is the caller's job, not this function's.** The
/// candidates that need buffering arrive on the inbound channel, and only
/// `run_one_session` reads that — so `answer_offer` deliberately takes no
/// buffer. It returns as soon as the answer is on the wire, and the caller
/// applies whatever arrived in the meantime via `flush_pending_candidates`.
///
/// `approved` is a policy check, not a prompt (§5.6.4): true when the offer's
/// capabilities contain `"terminal"`, false otherwise.
///
/// **A refusal still carries a real SDP.** `POST /api/signal/answer` rejects an
/// empty `sdp` with `400 VALIDATION_ERROR` (spec R19), so the refusal path calls
/// `create_answer` first and sends the real SDP with `approved: false`. A
/// refusal is therefore indistinguishable from a success at the transport layer
/// and visible only in the flag — honest, because the Worker does not act on the
/// flag today (`routes/signal.ts` stores `approved: body.approved !== false` and
/// nothing enforces it).
pub async fn answer_offer(
    peer: &Arc<dyn PeerConnection>,
    offer: &SignalOffer,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    let approved = offer.capabilities.iter().any(|c| c == TERMINAL_LABEL);
    send_answer(peer, offer, approved, outbound).await
}

/// Decline an offer while another session is live (ADR-14).
///
/// Still answers with a real SDP and `approved: false` — the browser's only
/// signal that the agent declined. `POST /api/signal/answer` rejects an empty
/// `sdp` (spec R19), so "refuse" cannot mean "send nothing".
pub async fn refuse_offer(
    peer: &Arc<dyn PeerConnection>,
    offer: &SignalOffer,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    send_answer(peer, offer, false, outbound).await
}

/// Set the remote description, produce an answer, send it with `approved`.
///
/// Shared by `answer_offer` and `refuse_offer` so the two cannot drift into
/// different SDP handling — the refusal path is the one that is never exercised
/// by the happy-path tests, and duplicated code there is how a refusal ends up
/// sending something the Worker rejects.
async fn send_answer(
    peer: &Arc<dyn PeerConnection>,
    offer: &SignalOffer,
    approved: bool,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    peer.set_remote_description(RTCSessionDescription::offer(offer.sdp.clone())?)
        .await
        .context("set_remote_description(offer)")?;

    let answer = peer.create_answer(None).await.context("create_answer")?;
    peer.set_local_description(answer.clone())
        .await
        .context("set_local_description")?;

    outbound
        .send(SignalMessage::Answer(SignalAnswer {
            session_id: offer.session_id.clone(),
            sdp: answer.sdp,
            approved,
            proof: None,
        }))
        .await
        .context("send answer")?;

    Ok(())
}

/// Apply one inbound candidate, buffering it if the remote description is not
/// set yet.
///
/// Returns `true` when the candidate was applied and `false` when it was
/// buffered. Buffering is not an optimisation: the browser trickles as soon as
/// it has the answer, so its first candidates routinely arrive before this side
/// has processed the offer, and `add_ice_candidate` fails outright with
/// `ErrNoRemoteDescription` (spec R3).
pub async fn apply_candidate(
    peer: &Arc<dyn PeerConnection>,
    pending: &mut Vec<RTCIceCandidateInit>,
    signal: IceCandidateSignal,
) -> Result<bool> {
    let index = narrow_mline_index(signal.sdp_mline_index)?;
    let init = RTCIceCandidateInit {
        candidate: signal.candidate,
        sdp_mid: signal.sdp_mid,
        sdp_mline_index: index,
        ..Default::default()
    };

    if peer.remote_description().await.is_none() {
        pending.push(init);
        return Ok(false);
    }

    peer.add_ice_candidate(init)
        .await
        .context("add_ice_candidate")?;
    Ok(true)
}

/// Fix up an outbound `RTCIceCandidateInit` for the wire.
///
/// rtc 0.21's `to_json()` still hardcodes `sdp_mid: Some("")` — a mid no m-line
/// has. The agent is a data-channel-only answerer with a single m-line, so the
/// candidate is addressed by `sdpMLineIndex` alone. Setting `sdp_mid` to
/// `None` makes the browser take the index path instead of searching for a
/// muxId of "". `sdpMLineIndex: Some(0)` (also from `to_json`) is correct
/// here: it is the one m-line.
fn prepare_outbound_candidate(mut init: RTCIceCandidateInit) -> RTCIceCandidateInit {
    init.sdp_mid = None;
    init
}

/// Convert an outbound crate candidate into the wire type.
///
/// There is no gathering-complete event to filter out in 0.21 — end of
/// candidates no longer arrives through `on_ice_candidate` at all. Because the
/// agent trickles, non-trickle (blocking) gathering helpers are not used.
pub fn candidate_to_wire(
    session_id: &str,
    init: RTCIceCandidateInit,
) -> Result<IceCandidateSignal> {
    Ok(IceCandidateSignal {
        session_id: session_id.to_string(),
        candidate: init.candidate,
        sdp_mid: init.sdp_mid,
        sdp_mline_index: init.sdp_mline_index.map(i32::from),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_index_narrowing() {
        // Spec R7: out-of-range is rejected at the boundary, not truncated —
        // a truncated index associates the candidate with the wrong media
        // section, which surfaces as an ICE failure with no useful error.
        assert!(narrow_mline_index(Some(-1)).is_err());
        assert!(narrow_mline_index(Some(70000)).is_err());
        assert_eq!(narrow_mline_index(Some(0)).unwrap(), Some(0));
        assert_eq!(narrow_mline_index(Some(65535)).unwrap(), Some(65535));
        assert_eq!(narrow_mline_index(None).unwrap(), None);
    }

    #[test]
    fn candidate_wire_round_trip() {
        // `candidate_to_wire` is the outbound half of the interop contract, so
        // the field names are what the browser parses: `sdpMid`/`sdpMLineIndex`
        // in camelCase, `candidate` verbatim.
        let signal = candidate_to_wire(
            "s1",
            RTCIceCandidateInit {
                candidate: "candidate:1 1 udp 2130706431 127.0.0.1 54321 typ host".to_string(),
                sdp_mid: Some("0".to_string()),
                sdp_mline_index: Some(0),
                ..Default::default()
            },
        )
        .unwrap();

        let json = serde_json::to_value(SignalMessage::IceCandidate(signal)).unwrap();
        assert_eq!(json["type"], "ice-candidate");
        assert_eq!(json["data"]["sessionId"], "s1");
        assert_eq!(json["data"]["sdpMid"], "0");
        assert_eq!(json["data"]["sdpMLineIndex"], 0);
        assert!(json["data"].get("sdp_mid").is_none(), "must be camelCase");
    }

    #[test]
    fn outbound_candidate_has_no_empty_mid() {
        // rtc 0.21's `to_json` still produces `sdp_mid: Some("")` and
        // `sdp_mline_index: Some(0)` — the override in `prepare_outbound_candidate`
        // must strip the empty mid so the browser falls through to the
        // `sdpMLineIndex` path. This test pins that: remove the override and it
        // goes red (`sdpMid` would be `""` instead of `null`).
        let init = prepare_outbound_candidate(RTCIceCandidateInit {
            candidate: "candidate:1 1 udp 2130706431 127.0.0.1 54321 typ host".to_string(),
            sdp_mid: Some("".to_string()),
            sdp_mline_index: Some(0),
            ..Default::default()
        });

        let signal = candidate_to_wire("s1", init).unwrap();
        let json = serde_json::to_value(SignalMessage::IceCandidate(signal)).unwrap();
        // `sdp_mid` is `None` → JSON `null`, not `""`.
        assert_eq!(json["data"]["sdpMid"], serde_json::Value::Null);
        assert_eq!(json["data"]["sdpMLineIndex"], 0);
    }

    #[test]
    fn turn_entry_from_the_pushed_frame_becomes_a_credentialed_ice_server() {
        // The pushed `ice-servers` frame is the agent's only source of TURN
        // configuration: it cannot call `GET /api/webrtc/ice-servers`, which
        // authenticates a user JWT. If this mapping drops the credentials, the
        // agent offers a TURN server it cannot authenticate to and ICE falls
        // back to failing.
        let entries = vec![IceServerEntry {
            urls: vec![
                "stun:stun.example.com:19302".to_string(),
                "turn:turn.example.com:3478?transport=udp".to_string(),
                "turn:turn.example.com:3478?transport=tcp".to_string(),
            ],
            username: Some("1700000000:user-1".to_string()),
            credential: Some("cred-abc".to_string()),
        }];

        let servers = ice_servers_from_entries(&entries);
        assert_eq!(servers.len(), 1);
        assert_eq!(
            servers[0].urls.len(),
            2,
            "TURN/TCP is dropped: rtc 0.21 cannot gather it"
        );
        assert_eq!(
            servers[0].username, "1700000000:user-1",
            "TURN credentials must survive the mapping"
        );
        assert_eq!(servers[0].credential, "cred-abc");
    }

    #[test]
    fn turn_tcp_urls_are_dropped_but_stun_and_turn_udp_survive() {
        // rtc 0.21's TURN relayer handles only `turn:` over UDP; every other
        // transport hits "Skipping unsupported non-UDP TURN url" and is
        // skipped. The server pushes `?transport=tcp` too because browsers do
        // support TURN/TCP, so the agent filters its own copy instead of asking
        // the server to degrade the browser's list. Keeping the URL would only
        // produce a WARN per gather and an attempt that can never succeed.
        let entries = vec![IceServerEntry {
            urls: vec![
                "stun:stun.example.com:19302".to_string(),
                "turn:turn.example.com:3478?transport=udp".to_string(),
                "turn:turn.example.com:3478?transport=tcp".to_string(),
            ],
            username: Some("1700000000:user-1".to_string()),
            credential: Some("cred-abc".to_string()),
        }];

        let servers = ice_servers_from_entries(&entries);
        assert_eq!(servers.len(), 1);
        assert_eq!(
            servers[0].urls,
            vec![
                "stun:stun.example.com:19302".to_string(),
                "turn:turn.example.com:3478?transport=udp".to_string(),
            ],
            "STUN and TURN/UDP must survive; TURN/TCP must not"
        );
    }

    #[test]
    fn a_turn_entry_left_with_no_usable_urls_is_dropped_entirely() {
        // The server could one day push a TCP-only entry; after the filter
        // its URL list is empty, and an ICE server with no URLs is not a
        // server — it must be dropped rather than mapped to an empty entry.
        let entries = vec![
            IceServerEntry {
                urls: vec!["turn:turn.example.com:3478?transport=tcp".to_string()],
                username: Some("1700000000:user-1".to_string()),
                credential: Some("cred-abc".to_string()),
            },
            IceServerEntry {
                urls: vec!["stun:stun.l.google.com:19302".to_string()],
                username: None,
                credential: None,
            },
        ];

        let servers = ice_servers_from_entries(&entries);
        assert_eq!(servers.len(), 1, "the TCP-only entry must be dropped");
        assert_eq!(servers[0].urls, vec!["stun:stun.l.google.com:19302"]);
    }

    #[test]
    #[cfg(not(target_env = "musl"))]
    fn session_ssrcs_are_distinct_and_never_zero() {
        // The SSRC only has to be unique per sender within one process. Two
        // sessions that started in the same nanosecond (impossible in practice,
        // but the counter makes it impossible in principle) must not collide,
        // and 0 is avoided so no stack sees a "zero SSRC" packet.
        let a = next_ssrc();
        let b = next_ssrc();
        assert_ne!(a, b, "the per-process counter must break ties");
        assert_ne!(a, 0);
        assert_ne!(b, 0);
    }

    #[test]
    fn stun_only_entries_map_without_credentials() {
        let entries = vec![IceServerEntry {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            username: None,
            credential: None,
        }];

        let servers = ice_servers_from_entries(&entries);
        assert_eq!(servers.len(), 1);
        assert_eq!(
            servers[0].urls,
            vec!["stun:stun.l.google.com:19302".to_string()]
        );
        assert!(servers[0].username.is_empty());
        assert!(servers[0].credential.is_empty());
    }

    #[test]
    fn an_empty_pushed_list_falls_back_to_the_configured_stun_url() {
        // A deployment with no TURN may push nothing at all; the agent must
        // still get the `--stun` value it was started with rather than an
        // empty ICE server list.
        let servers = ice_servers_from_entries(&[]);
        assert!(servers.is_empty(), "no pushed entries means no override");
    }

    #[cfg(not(target_env = "musl"))]
    fn codec(mime_type: &str, payload_type: PayloadType) -> RTCRtpCodecParameters {
        RTCRtpCodecParameters {
            rtp_codec: RTCRtpCodec {
                mime_type: mime_type.to_owned(),
                clock_rate: 90_000,
                channels: 0,
                sdp_fmtp_line: String::new(),
                rtcp_feedback: vec![],
            },
            payload_type,
        }
    }

    #[cfg(not(target_env = "musl"))]
    #[test]
    fn desktop_payload_type_is_h264_even_when_vp8_is_offered_first() {
        // The regression for the black-screen bug: a real Chrome offer lists
        // VP8 (96) before H.264 (102), and rtc keeps the offer's order, so
        // `codecs.first()` was VP8's PT. The desktop track only ever emits
        // H.264, so stamping PT 96 on H.264 payload made Chrome hand the bytes
        // to its VP8 decoder and show a black frame. The selection must find
        // the H.264 entry wherever it sits in the list.
        let codecs = vec![
            codec("video/VP8", 96),
            codec("video/rtx", 97),
            codec("video/H264", 102),
            codec("video/H264", 127),
        ];
        assert_eq!(
            select_h264_payload_type(&codecs),
            Some(102),
            "the first H.264 entry's payload type must win, not the first entry",
        );
    }

    #[cfg(not(target_env = "musl"))]
    #[test]
    fn desktop_payload_type_matches_the_h264_mime_case_insensitively() {
        // werift normalises the mime type to lowercase at parse time; the match
        // must not depend on the casing the crate happens to carry.
        let codecs = vec![codec("video/vp8", 96), codec("video/h264", 102)];
        assert_eq!(select_h264_payload_type(&codecs), Some(102));
    }

    #[cfg(not(target_env = "musl"))]
    #[test]
    fn desktop_payload_type_is_none_when_no_h264_was_negotiated() {
        // With no H.264 m-line there is nothing to stamp; `desktop_stream_params`
        // turns this `None` into a hard error rather than silently sending
        // H.264 bytes under another codec's payload type.
        let codecs = vec![codec("video/VP8", 96), codec("video/VP9", 98)];
        assert_eq!(select_h264_payload_type(&codecs), None);
    }

    #[cfg(not(target_env = "musl"))]
    #[test]
    fn reporting_estimator_publishes_its_initial_target() {
        // The wrapper's whole job is to make GCC's target observable from the
        // application: before any feedback arrives it must publish exactly the
        // seed it was constructed with, so the auto-ABR loop can tell "nothing
        // reported yet" (the seed) from a real measurement.
        let (_estimator, handle) = abr::estimator();
        let published = f64::from_bits(handle.load(std::sync::atomic::Ordering::Relaxed));
        assert_eq!(published, ABR_INITIAL_BPS);
    }
}

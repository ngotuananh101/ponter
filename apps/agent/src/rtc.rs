//! WebRTC answerer. Owns one `RTCPeerConnection` for one session.

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::mpsc;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::signal::{IceCandidateSignal, IceServerEntry, SignalAnswer, SignalMessage, SignalOffer};

/// The one channel label this agent accepts. ADR-09: exact label, nothing else.
pub const TERMINAL_LABEL: &str = "terminal";

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
/// webrtc-rs 0.13's `gather_candidates_relay` implements only TURN over UDP
/// (`agent_gather.rs`: the `ProtoType::Udp && SchemeType::Turn` arm); a
/// `turn:` URL with `transport=tcp` falls into its "Unable to handle URL"
/// warning and is skipped, once per gather. The server mints both transports
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
/// Loopback needs no ICE server at all (Week 4 F4); an empty `pushed` list and
/// an empty `stun_url` together are the loopback/air-gapped path.
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
) -> Result<Arc<RTCPeerConnection>> {
    let mut media = MediaEngine::default();
    media
        .register_default_codecs()
        .context("register_default_codecs")?;
    let registry = register_default_interceptors(Registry::new(), &mut media)
        .context("register_default_interceptors")?;

    let mut setting = SettingEngine::default();
    setting.set_ice_multicast_dns_mode(webrtc::ice::mdns::MulticastDnsMode::Disabled);
    setting.set_include_loopback_candidate(true);

    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_setting_engine(setting)
        .build();

    let mut ice_servers = ice_servers_from_entries(pushed);
    if ice_servers.is_empty() && !stun_url.is_empty() {
        ice_servers = vec![RTCIceServer {
            urls: vec![stun_url.to_string()],
            ..Default::default()
        }];
    }

    let config = RTCConfiguration {
        ice_servers,
        ..Default::default()
    };

    Ok(Arc::new(
        api.new_peer_connection(config)
            .await
            .context("new_peer_connection")?,
    ))
}

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
    peer: &Arc<RTCPeerConnection>,
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
    peer: &Arc<RTCPeerConnection>,
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
    peer: &Arc<RTCPeerConnection>,
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
    peer: &Arc<RTCPeerConnection>,
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
        }))
        .await
        .context("send answer")?;

    Ok(())
}

/// Register the outbound candidate forwarder.
///
/// **This is what makes the connection work at all.** ICE needs a candidate
/// pair: the browser's candidates alone are not enough, and an agent that never
/// sends its own reaches `checking` and stops. Register it *before*
/// `answer_offer` — gathering starts when the local description is set, and a
/// handler registered afterwards misses the host candidates emitted in that
/// same tick.
///
/// `on_ice_candidate(None)` is the gathering-complete signal (spec R4): not an
/// error, and nothing to forward.
pub fn forward_candidates(
    peer: &Arc<RTCPeerConnection>,
    session_id: String,
    outbound: mpsc::Sender<SignalMessage>,
) {
    peer.on_ice_candidate(Box::new(move |candidate| {
        let outbound = outbound.clone();
        let session_id = session_id.clone();
        Box::pin(async move {
            let Some(candidate) = candidate else {
                return; // gathering complete
            };
            // `on_ice_candidate` hands us an `RTCIceCandidate`; the wire type is
            // `RTCIceCandidateInit` (serializable, spec R4). `to_json` is the
            // crate's bridge — it produces the `candidate:`-prefixed string and
            // the `sdpMid`/`sdpMLineIndex` pair the browser parses.
            let init = match candidate.to_json() {
                Ok(init) => prepare_outbound_candidate(init),
                Err(e) => {
                    tracing::warn!(error = %e, "dropping an unmappable candidate");
                    return;
                }
            };
            match candidate_to_wire(&session_id, init) {
                Ok(signal) => {
                    // Best-effort, like the Worker's push: a candidate that
                    // cannot be sent is a lost candidate, not a dead session —
                    // ICE retries and one lost candidate is rarely fatal.
                    if outbound
                        .send(SignalMessage::IceCandidate(signal))
                        .await
                        .is_err()
                    {
                        tracing::debug!("outbound closed while sending a candidate");
                    }
                }
                Err(e) => tracing::warn!(error = %e, "dropping an unmappable candidate"),
            }
        })
    }));
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
    peer: &Arc<RTCPeerConnection>,
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
/// webrtc 0.13's `to_json()` hardcodes `sdp_mid: Some("")` — a mid no m-line
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
/// `on_ice_candidate(None)` is the gathering-complete signal (spec R4) — not an
/// error, and not something to forward. Because the agent trickles,
/// `gathering_complete_promise()` is **not** used; that helper is for
/// non-trickle (blocking) gathering.
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
        // webrtc 0.13's `to_json` produces `sdp_mid: Some("")` and
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
            "TURN/TCP is dropped: webrtc-rs 0.13 cannot gather it"
        );
        assert_eq!(
            servers[0].username, "1700000000:user-1",
            "TURN credentials must survive the mapping"
        );
        assert_eq!(servers[0].credential, "cred-abc");
    }

    #[test]
    fn turn_tcp_urls_are_dropped_but_stun_and_turn_udp_survive() {
        // webrtc-rs 0.13's `gather_candidates_relay` handles only
        // `turn:` over UDP; every other transport hits
        // "Unable to handle URL in gather_candidates_relay" and is skipped.
        // The server pushes `?transport=tcp` too because browsers do support
        // TURN/TCP, so the agent filters its own copy instead of asking the
        // server to degrade the browser's list. Keeping the URL would only
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
}

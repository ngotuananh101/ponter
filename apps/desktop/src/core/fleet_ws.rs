//! Fleet push-primary state machine and WebSocket ticket minting (ADR-73..77, ADR-82).
//!
//! Provides push-first fleet updates via `/api/ws/browser` subscribing to
//! `fleet-changed` events, with fallback polling whenever WebSocket is
//! unavailable.

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

/// The active update layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    Push,
    Fallback,
}

/// Events driving the fleet layer state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FleetEvent {
    WsConnected,
    WsUnusable,
    OriginGateRejected,
    PollTick,
    FleetChanged,
    FetchStarted,
    FetchFinished,
}

/// State machine tracking push vs fallback layer and signal coalescing.
#[derive(Debug, Clone)]
pub struct FleetLayerState {
    layer: Layer,
    poll_armed: bool,
    dirty: bool,
    fetch_in_flight: bool,
}

impl FleetLayerState {
    pub fn new() -> Self {
        Self {
            layer: Layer::Push,
            poll_armed: false,
            dirty: false,
            fetch_in_flight: false,
        }
    }

    pub fn layer(&self) -> Layer {
        self.layer
    }

    pub fn poll_armed(&self) -> bool {
        self.poll_armed
    }

    pub fn on(&mut self, ev: FleetEvent) {
        match ev {
            FleetEvent::WsConnected => {
                self.poll_armed = false;
                self.layer = Layer::Push;
            }
            FleetEvent::WsUnusable | FleetEvent::OriginGateRejected => {
                self.layer = Layer::Fallback;
                self.poll_armed = true;
            }
            FleetEvent::PollTick => {
                if self.layer == Layer::Fallback {
                    self.dirty = true;
                }
            }
            FleetEvent::FleetChanged => {
                self.dirty = true;
            }
            FleetEvent::FetchStarted => {
                self.fetch_in_flight = true;
                self.dirty = false;
            }
            FleetEvent::FetchFinished => {
                self.fetch_in_flight = false;
            }
        }
        debug_assert!(
            !(self.layer == Layer::Push && self.poll_armed),
            "Guard (g) invariant violated: layer is Push but poll is armed"
        );
    }

    pub fn should_fetch(&self) -> bool {
        self.dirty && !self.fetch_in_flight
    }

    pub fn take_dirty(&mut self) -> bool {
        let d = self.dirty;
        self.dirty = false;
        d
    }
}

impl Default for FleetLayerState {
    fn default() -> Self {
        Self::new()
    }
}

/// Deserialized ticket response from `POST /api/ws/ticket`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketResponse {
    pub ticket: String,
    pub expires_in: u64,
}

/// Mint a single-use WebSocket ticket via `POST /api/ws/ticket`.
pub async fn mint_ticket(
    client: &reqwest::Client,
    server_url: &str,
    access_token: &str,
) -> Result<String, String> {
    let base = server_url.trim_end_matches('/');
    let url = format!("{base}/api/ws/ticket");

    let resp = client
        .post(&url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {access_token}"),
        )
        .send()
        .await
        .map_err(|e| format!("ticket request network error: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("ticket request failed ({status}): {body}"));
    }

    let parsed: TicketResponse = resp
        .json()
        .await
        .map_err(|e| format!("failed to parse ticket response: {e}"))?;

    Ok(parsed.ticket)
}

/// Derive the browser signaling WebSocket URL from server URL and ticket.
pub fn browser_ws_url(server_url: &str, ticket: &str) -> Result<String, String> {
    let trimmed = server_url.trim_end_matches('/');
    let ws = if trimmed.starts_with("http://") {
        trimmed.replacen("http://", "ws://", 1)
    } else if trimmed.starts_with("https://") {
        trimmed.replacen("https://", "wss://", 1)
    } else if trimmed.starts_with("ws://") || trimmed.starts_with("wss://") {
        trimmed.to_string()
    } else {
        return Err(format!(
            "server URL must use http://, https://, ws://, or wss:// (got: {})",
            trimmed
        ));
    };
    Ok(format!("{ws}/api/ws/browser?ticket={ticket}"))
}

/// Helper struct for deserializing inbound WebSocket frames.
#[derive(Debug, Deserialize)]
struct InboundFleetFrame {
    #[serde(rename = "type")]
    frame_type: String,
}

/// Long-lived orchestrator task driving WebSocket connection and polling fallback.
pub async fn run(
    state: std::sync::Arc<crate::core::state::CoreState>,
    tx: tokio::sync::mpsc::Sender<crate::app::Msg>,
    shutdown_rx: tokio::sync::watch::Receiver<bool>,
) {
    run_with_intervals(
        state,
        tx,
        shutdown_rx,
        std::time::Duration::from_secs(60),
        std::time::Duration::from_secs(5),
    )
    .await;
}

/// Configurable orchestrator task driving WebSocket connection and polling fallback.
pub async fn run_with_intervals(
    state: std::sync::Arc<crate::core::state::CoreState>,
    tx: tokio::sync::mpsc::Sender<crate::app::Msg>,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
    poll_interval_duration: std::time::Duration,
    retry_interval_duration: std::time::Duration,
) {
    let mut layer_state = FleetLayerState::new();

    while !*shutdown_rx.borrow() {
        let (server_url, token) = {
            let url = state
                .server_url
                .lock()
                .map(|u| u.clone())
                .unwrap_or_default();
            let tok = state
                .access_token
                .lock()
                .map(|t| t.clone())
                .unwrap_or_default();
            (url, tok)
        };

        let token = match token {
            Some(t) if !t.trim().is_empty() => t,
            _ => {
                tokio::select! {
                    _ = tokio::time::sleep(retry_interval_duration) => {}
                    _ = shutdown_rx.changed() => break,
                }
                continue;
            }
        };

        match mint_ticket(&state.http, &server_url, &token).await {
            Ok(ticket) => match browser_ws_url(&server_url, &ticket) {
                Ok(ws_url) => match tokio_tungstenite::connect_async(&ws_url).await {
                    Ok((mut ws_stream, _)) => {
                        layer_state.on(FleetEvent::WsConnected);

                        let sub_msg = tokio_tungstenite::tungstenite::Message::Text(
                            r#"{"type":"subscribe-fleet"}"#.into(),
                        );
                        if let Err(e) = ws_stream.send(sub_msg).await {
                            eprintln!("failed to send subscribe-fleet: {e}");
                            layer_state.on(FleetEvent::WsUnusable);
                        } else {
                            loop {
                                tokio::select! {
                                    frame = ws_stream.next() => {
                                        match frame {
                                            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                                                if let Ok(inbound) = serde_json::from_str::<InboundFleetFrame>(&text) {
                                                    if inbound.frame_type == "fleet-changed" {
                                                        layer_state.on(FleetEvent::FleetChanged);
                                                        if layer_state.should_fetch() {
                                                            layer_state.on(FleetEvent::FetchStarted);
                                                            let _ = tx.send(crate::app::Msg::FleetChanged).await;
                                                            layer_state.on(FleetEvent::FetchFinished);
                                                        }
                                                    }
                                                }
                                            }
                                            Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => {
                                                layer_state.on(FleetEvent::WsUnusable);
                                                break;
                                            }
                                            Some(Err(_)) => {
                                                layer_state.on(FleetEvent::WsUnusable);
                                                break;
                                            }
                                            _ => {}
                                        }
                                    }
                                    _ = shutdown_rx.changed() => {
                                        return;
                                    }
                                }
                            }
                        }
                    }
                    Err(tokio_tungstenite::tungstenite::Error::Http(resp))
                        if resp.status().as_u16() == 403 =>
                    {
                        layer_state.on(FleetEvent::OriginGateRejected);
                    }
                    Err(_) => {
                        layer_state.on(FleetEvent::WsUnusable);
                    }
                },
                Err(_) => {
                    layer_state.on(FleetEvent::WsUnusable);
                }
            },
            Err(_) => {
                layer_state.on(FleetEvent::WsUnusable);
            }
        }

        if layer_state.layer() == Layer::Fallback {
            let mut poll_timer = tokio::time::interval(poll_interval_duration);
            poll_timer.tick().await;

            tokio::select! {
                _ = poll_timer.tick() => {
                    layer_state.on(FleetEvent::PollTick);
                    if layer_state.should_fetch() {
                        layer_state.on(FleetEvent::FetchStarted);
                        let _ = tx.send(crate::app::Msg::FleetChanged).await;
                        layer_state.on(FleetEvent::FetchFinished);
                    }
                }
                _ = tokio::time::sleep(retry_interval_duration) => {}
                _ = shutdown_rx.changed() => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_in_push_layer_with_poll_disarmed() {
        let s = FleetLayerState::new();
        assert_eq!(s.layer(), Layer::Push);
        assert!(!s.poll_armed());
        assert!(!s.should_fetch());
    }

    #[test]
    fn ws_unusable_switches_to_fallback_and_arms_poll() {
        let mut s = FleetLayerState::new();
        s.on(FleetEvent::WsUnusable);
        assert_eq!(s.layer(), Layer::Fallback);
        assert!(s.poll_armed());
    }

    #[test]
    fn origin_gate_403_switches_to_fallback() {
        let mut s = FleetLayerState::new();
        s.on(FleetEvent::OriginGateRejected);
        assert_eq!(s.layer(), Layer::Fallback);
        assert!(s.poll_armed());
    }

    #[test]
    fn successful_reconnect_disarms_poll_before_push_active() {
        let mut s = FleetLayerState::new();
        s.on(FleetEvent::WsUnusable);
        assert_eq!(s.layer(), Layer::Fallback);
        assert!(s.poll_armed());
        s.on(FleetEvent::WsConnected);
        assert_eq!(s.layer(), Layer::Push);
        assert!(!s.poll_armed());
    }

    #[test]
    fn signal_during_in_flight_fetch_coalesces_and_replays() {
        let mut s = FleetLayerState::new();
        s.on(FleetEvent::FleetChanged);
        assert!(s.should_fetch());
        s.on(FleetEvent::FetchStarted);
        assert!(!s.should_fetch());
        s.on(FleetEvent::FleetChanged);
        assert!(!s.should_fetch());
        s.on(FleetEvent::FetchFinished);
        assert!(s.should_fetch());
    }

    #[test]
    fn poll_tick_only_signals_in_fallback() {
        let mut s = FleetLayerState::new();
        assert_eq!(s.layer(), Layer::Push);
        s.on(FleetEvent::PollTick);
        assert!(!s.should_fetch());
        assert!(!s.take_dirty());

        s.on(FleetEvent::WsUnusable);
        assert_eq!(s.layer(), Layer::Fallback);
        s.on(FleetEvent::PollTick);
        assert!(s.should_fetch());
        assert!(s.take_dirty());
    }

    #[test]
    fn take_dirty_consumes_the_signal() {
        let mut s = FleetLayerState::new();
        s.on(FleetEvent::FleetChanged);
        assert!(s.should_fetch());
        assert!(s.take_dirty());
        assert!(!s.should_fetch());
        assert!(!s.take_dirty());
    }

    #[test]
    fn layers_are_never_both_active_across_a_full_cycle() {
        let mut s = FleetLayerState::new();
        assert!(!(s.layer() == Layer::Push && s.poll_armed()));

        let sequence = [
            FleetEvent::WsConnected,
            FleetEvent::FleetChanged,
            FleetEvent::FetchStarted,
            FleetEvent::WsUnusable,
            FleetEvent::PollTick,
            FleetEvent::FetchFinished,
            FleetEvent::OriginGateRejected,
            FleetEvent::PollTick,
            FleetEvent::WsConnected,
        ];

        for ev in sequence {
            s.on(ev);
            assert!(
                !(s.layer() == Layer::Push && s.poll_armed()),
                "Guard (g) invariant violated: layer is {:?} and poll_armed is {}",
                s.layer(),
                s.poll_armed()
            );
        }
    }

    #[test]
    fn browser_ws_url_converts_http_and_https() {
        let u1 = browser_ws_url("http://localhost:8787", "ticket-123").unwrap();
        assert_eq!(u1, "ws://localhost:8787/api/ws/browser?ticket=ticket-123");

        let u2 = browser_ws_url("https://example.com/", "ticket-456").unwrap();
        assert_eq!(u2, "wss://example.com/api/ws/browser?ticket=ticket-456");

        let u3 = browser_ws_url("ws://localhost:8787", "t").unwrap();
        assert_eq!(u3, "ws://localhost:8787/api/ws/browser?ticket=t");

        let u4 = browser_ws_url("wss://example.com", "t").unwrap();
        assert_eq!(u4, "wss://example.com/api/ws/browser?ticket=t");

        let err = browser_ws_url("ftp://localhost", "ticket");
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn mint_ticket_parses_ticket_and_maps_error() {
        crate::core::test_util::ensure_provider();
        let (base_url, rx) = crate::core::test_util::spawn_stub_capturing(
            200,
            r#"{"ticket":"m1nt-t1ck3t","expiresIn":15}"#.to_string(),
        );
        let client = reqwest::Client::new();
        let res = mint_ticket(&client, &base_url, "bearer-token-abc").await;
        assert_eq!(res.unwrap(), "m1nt-t1ck3t");

        let req = rx.recv().expect("captured request");
        assert!(req.contains("POST /api/ws/ticket"));
        assert!(
            req.contains("authorization: Bearer bearer-token-abc")
                || req.contains("Authorization: Bearer bearer-token-abc")
        );

        let err_url =
            crate::core::test_util::spawn_stub(401, r#"{"error":"Unauthorized"}"#.to_string());
        let err_res = mint_ticket(&client, &err_url, "bad-token").await;
        assert!(err_res.is_err());
    }
}

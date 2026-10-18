//! D-Bus `org.freedesktop.portal.RemoteDesktop` & `ScreenCast` client (ADR-90 §5.1).

use anyhow::{bail, Result};

use crate::portal::token_store;

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
use anyhow::Context;

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(1);

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
fn generate_token(prefix: &str) -> String {
    let count = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}_{nanos}_{count}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDesktopStreamInfo {
    pub node_id: u32,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDesktopSessionResult {
    pub session_handle: String,
    pub streams: Vec<RemoteDesktopStreamInfo>,
    pub devices: u32,
    pub restore_token: Option<String>,
}

pub trait RemoteDesktopPortal: Send + Sync {
    fn create_session(&self) -> Result<String>;
    fn select_devices(
        &self,
        session: &str,
        device_mask: u32,
        restore_token: Option<&str>,
    ) -> Result<()>;
    fn select_sources(&self, session: &str, restore_token: Option<&str>) -> Result<()>;
    fn start(
        &self,
        session: &str,
        restore_token: Option<&str>,
    ) -> Result<RemoteDesktopSessionResult>;
}

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
pub struct ZbusRemoteDesktopPortal {
    connection: zbus::blocking::Connection,
}

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
impl ZbusRemoteDesktopPortal {
    pub fn new() -> Result<Self> {
        let connection =
            zbus::blocking::Connection::session().context("connecting to D-Bus session bus")?;
        Ok(Self { connection })
    }

    pub fn with_connection(connection: zbus::blocking::Connection) -> Self {
        Self { connection }
    }

    fn portal_request_proxy<'a>(&'a self, handle_token: &str) -> Result<zbus::blocking::Proxy<'a>> {
        let unique = self
            .connection
            .unique_name()
            .context("getting D-Bus unique name")?
            .as_str()
            .trim_start_matches(':')
            .replace('.', "_");
        let path = format!("/org/freedesktop/portal/desktop/request/{unique}/{handle_token}");
        zbus::blocking::Proxy::new(
            &self.connection,
            "org.freedesktop.portal.Desktop",
            path,
            "org.freedesktop.portal.Request",
        )
        .context("creating Request proxy")
    }
}

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
impl RemoteDesktopPortal for ZbusRemoteDesktopPortal {
    fn create_session(&self) -> Result<String> {
        let proxy = zbus::blocking::Proxy::new(
            &self.connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.RemoteDesktop",
        )?;

        let handle_token = generate_token("create_req");
        let session_handle_token = generate_token("session");
        let req_proxy = self.portal_request_proxy(&handle_token)?;

        let mut options = HashMap::new();
        options.insert("handle_token", zbus::zvariant::Value::from(&handle_token));
        options.insert(
            "session_handle_token",
            zbus::zvariant::Value::from(&session_handle_token),
        );

        let mut signals = req_proxy.receive_signal("Response")?;
        proxy.call_method("CreateSession", &(options))?;

        let msg = signals
            .next()
            .context("no response signal from portal CreateSession")?;
        let (code, dict): (u32, HashMap<String, zbus::zvariant::OwnedValue>) =
            msg.body().deserialize()?;
        if code != 0 {
            bail!("CreateSession failed with response code {code}");
        }

        let session_handle = dict
            .get("session_handle")
            .and_then(|v| {
                if let Ok(s) = v.downcast_ref::<&str>() {
                    Some(s.to_string())
                } else if let Ok(p) = v.downcast_ref::<zbus::zvariant::ObjectPath>() {
                    Some(p.as_str().to_string())
                } else {
                    None
                }
            })
            .context("missing session_handle in portal response")?;

        Ok(session_handle)
    }

    fn select_devices(
        &self,
        session: &str,
        device_mask: u32,
        restore_token: Option<&str>,
    ) -> Result<()> {
        let proxy = zbus::blocking::Proxy::new(
            &self.connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.RemoteDesktop",
        )?;

        let handle_token = generate_token("sel_dev");
        let req_proxy = self.portal_request_proxy(&handle_token)?;

        let mut options = HashMap::new();
        options.insert("handle_token", zbus::zvariant::Value::from(&handle_token));
        options.insert("types", zbus::zvariant::Value::from(device_mask));
        options.insert("persist_mode", zbus::zvariant::Value::from(2_u32));
        if let Some(token) = restore_token {
            options.insert("restore_token", zbus::zvariant::Value::from(token));
        }

        let mut signals = req_proxy.receive_signal("Response")?;
        let session_path = zbus::zvariant::ObjectPath::try_from(session)?;
        proxy.call_method("SelectDevices", &(session_path, options))?;

        let msg = signals
            .next()
            .context("no response signal from SelectDevices")?;
        let (code, _): (u32, HashMap<String, zbus::zvariant::OwnedValue>) =
            msg.body().deserialize()?;
        if code != 0 {
            bail!("SelectDevices failed with code {code}");
        }
        Ok(())
    }

    fn select_sources(&self, session: &str, restore_token: Option<&str>) -> Result<()> {
        let proxy = zbus::blocking::Proxy::new(
            &self.connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast",
        )?;

        let handle_token = generate_token("sel_src");
        let req_proxy = self.portal_request_proxy(&handle_token)?;

        let mut options = HashMap::new();
        options.insert("handle_token", zbus::zvariant::Value::from(&handle_token));
        options.insert("types", zbus::zvariant::Value::from(1_u32)); // Monitor type
        options.insert("multiple", zbus::zvariant::Value::from(false));
        options.insert("cursor_mode", zbus::zvariant::Value::from(2_u32)); // Embedded cursor
        options.insert("persist_mode", zbus::zvariant::Value::from(2_u32)); // Persist until revoked

        if let Some(token) = restore_token {
            options.insert("restore_token", zbus::zvariant::Value::from(token));
        }

        let mut signals = req_proxy.receive_signal("Response")?;
        let session_path = zbus::zvariant::ObjectPath::try_from(session)?;
        proxy.call_method("SelectSources", &(session_path, options))?;

        let msg = signals
            .next()
            .context("no response signal from SelectSources")?;
        let (code, _): (u32, HashMap<String, zbus::zvariant::OwnedValue>) =
            msg.body().deserialize()?;
        if code != 0 {
            bail!("SelectSources failed with code {code}");
        }
        Ok(())
    }

    fn start(
        &self,
        session: &str,
        restore_token: Option<&str>,
    ) -> Result<RemoteDesktopSessionResult> {
        let proxy = zbus::blocking::Proxy::new(
            &self.connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.RemoteDesktop",
        )?;

        let handle_token = generate_token("start");
        let req_proxy = self.portal_request_proxy(&handle_token)?;

        let mut options = HashMap::new();
        options.insert("handle_token", zbus::zvariant::Value::from(&handle_token));
        if let Some(token) = restore_token {
            options.insert("restore_token", zbus::zvariant::Value::from(token));
        }

        let mut signals = req_proxy.receive_signal("Response")?;
        let session_path = zbus::zvariant::ObjectPath::try_from(session)?;
        proxy.call_method("Start", &(session_path, "", options))?;

        let msg = signals.next().context("no response signal from Start")?;
        let (code, dict): (u32, HashMap<String, zbus::zvariant::OwnedValue>) =
            msg.body().deserialize()?;
        if code != 0 {
            bail!("portal Start failed with response code {code}");
        }

        let devices = dict
            .get("devices")
            .and_then(|v| v.downcast_ref::<u32>().ok())
            .unwrap_or(0);

        let new_restore_token = dict
            .get("restore_token")
            .and_then(|v| v.downcast_ref::<&str>().ok())
            .map(|s| s.to_string());

        #[cfg(all(target_os = "linux", not(target_env = "musl")))]
        fn parse_stream_size(val: &zbus::zvariant::Value) -> (Option<i32>, Option<i32>) {
            if let Ok(dict) = val.downcast_ref::<zbus::zvariant::Dict>() {
                let mut width = None;
                let mut height = None;
                for (k, v) in dict.iter() {
                    if let Ok(key) = k.downcast_ref::<&str>() {
                        match key {
                            "size" => {
                                if let Ok(st) = v.downcast_ref::<zbus::zvariant::Structure>() {
                                    let f = st.fields();
                                    if f.len() >= 2 {
                                        width = f[0].downcast_ref::<i32>().ok().or_else(|| {
                                            f[0].downcast_ref::<u32>().ok().map(|x| x as i32)
                                        });
                                        height = f[1].downcast_ref::<i32>().ok().or_else(|| {
                                            f[1].downcast_ref::<u32>().ok().map(|x| x as i32)
                                        });
                                    }
                                }
                            }
                            "width" if width.is_none() => {
                                width = v
                                    .downcast_ref::<i32>()
                                    .ok()
                                    .or_else(|| v.downcast_ref::<u32>().ok().map(|x| x as i32));
                            }
                            "height" if height.is_none() => {
                                height = v
                                    .downcast_ref::<i32>()
                                    .ok()
                                    .or_else(|| v.downcast_ref::<u32>().ok().map(|x| x as i32));
                            }
                            _ => {}
                        }
                    }
                }
                (width, height)
            } else {
                (None, None)
            }
        }

        // Parse streams
        let mut streams = Vec::new();
        if let Some(raw_streams) = dict.get("streams") {
            if let Ok(arr) = raw_streams.downcast_ref::<zbus::zvariant::Array>() {
                for item in arr.iter() {
                    if let Ok(tuple) = item.downcast_ref::<zbus::zvariant::Structure>() {
                        let fields = tuple.fields();
                        if let Some(node_id) =
                            fields.first().and_then(|f| f.downcast_ref::<u32>().ok())
                        {
                            let (width, height) = if fields.len() > 1 {
                                parse_stream_size(&fields[1])
                            } else {
                                (None, None)
                            };
                            streams.push(RemoteDesktopStreamInfo {
                                node_id,
                                width,
                                height,
                            });
                        }
                    }
                }
            }
        }

        Ok(RemoteDesktopSessionResult {
            session_handle: session.to_string(),
            streams,
            devices,
            restore_token: new_restore_token,
        })
    }
}

/// Unified portal session initialization with self-healing token retry (ADR-90 §5.2, §8.3).
///
/// If `stored_token` is provided, attempts to initialize with it. If the portal rejects the
/// call (e.g. user revoked permission in settings), clears the stored token from disk and
/// retries once without a token to trigger a fresh prompt.
pub fn initialize_portal_session<P: RemoteDesktopPortal>(
    portal: &P,
    device_mask: u32,
    stored_token: Option<&str>,
) -> Result<RemoteDesktopSessionResult> {
    let mut current_token = stored_token;
    let mut tried_stored = false;

    loop {
        let session_handle = match portal.create_session() {
            Ok(handle) => handle,
            Err(e) => {
                if !tried_stored && current_token.is_some() {
                    tracing::debug!(
                        error = %e,
                        "create_session failed with token, clearing and retrying once without token"
                    );
                    let _ = token_store::clear_token();
                    current_token = None;
                    tried_stored = true;
                    continue;
                }
                bail!("portal create_session failed: {e}");
            }
        };

        if let Err(e) = portal.select_devices(&session_handle, device_mask, current_token) {
            if !tried_stored && current_token.is_some() {
                tracing::debug!(
                    error = %e,
                    "select_devices failed with token, clearing and retrying once without token"
                );
                let _ = token_store::clear_token();
                current_token = None;
                tried_stored = true;
                continue;
            }
            bail!("portal select_devices failed: {e}");
        }

        if let Err(e) = portal.select_sources(&session_handle, current_token) {
            if !tried_stored && current_token.is_some() {
                tracing::debug!(
                    error = %e,
                    "select_sources failed with token, clearing and retrying once without token"
                );
                let _ = token_store::clear_token();
                current_token = None;
                tried_stored = true;
                continue;
            }
            bail!("portal select_sources failed: {e}");
        }

        match portal.start(&session_handle, current_token) {
            Ok(res) => {
                if let Some(ref new_token) = res.restore_token {
                    let _ = token_store::save_token(new_token, device_mask);
                }
                return Ok(res);
            }
            Err(e) => {
                if !tried_stored && current_token.is_some() {
                    tracing::debug!(
                        error = %e,
                        "portal start failed with token, clearing and retrying once without token"
                    );
                    let _ = token_store::clear_token();
                    current_token = None;
                    tried_stored = true;
                    continue;
                }
                bail!("portal start failed: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockRemoteDesktopPortal {
        should_fail_token: bool,
    }

    impl RemoteDesktopPortal for MockRemoteDesktopPortal {
        fn create_session(&self) -> Result<String> {
            Ok("/org/freedesktop/portal/desktop/session/mock/session1".to_string())
        }

        fn select_devices(
            &self,
            _session: &str,
            _device_mask: u32,
            _restore_token: Option<&str>,
        ) -> Result<()> {
            Ok(())
        }

        fn select_sources(&self, _session: &str, _restore_token: Option<&str>) -> Result<()> {
            Ok(())
        }

        fn start(
            &self,
            session: &str,
            restore_token: Option<&str>,
        ) -> Result<RemoteDesktopSessionResult> {
            if self.should_fail_token && restore_token.is_some() {
                anyhow::bail!("revoked or invalid restore_token");
            }
            Ok(RemoteDesktopSessionResult {
                session_handle: session.to_string(),
                streams: vec![RemoteDesktopStreamInfo {
                    node_id: 42,
                    width: Some(1920),
                    height: Some(1080),
                }],
                devices: 3,
                restore_token: Some("new-minted-token-67890".to_string()),
            })
        }
    }

    #[test]
    fn full_portal_handshake_happy_path() {
        let portal = MockRemoteDesktopPortal {
            should_fail_token: false,
        };
        let session = portal.create_session().expect("create_session succeeds");
        portal
            .select_devices(&session, 3, Some("cached-token"))
            .expect("select_devices succeeds");
        portal
            .select_sources(&session, Some("cached-token"))
            .expect("select_sources succeeds");
        let res = portal
            .start(&session, Some("cached-token"))
            .expect("start succeeds");

        assert_eq!(res.devices, 3);
        assert_eq!(res.streams.len(), 1);
        assert_eq!(res.streams[0].node_id, 42);
        assert_eq!(res.restore_token.as_deref(), Some("new-minted-token-67890"));
    }

    #[test]
    fn revoked_token_triggers_error_for_caller_retry() {
        let portal = MockRemoteDesktopPortal {
            should_fail_token: true,
        };
        let session = portal.create_session().unwrap();
        let _ = portal.select_devices(&session, 3, Some("bad-token"));
        let _ = portal.select_sources(&session, Some("bad-token"));
        let err = portal.start(&session, Some("bad-token")).unwrap_err();
        assert!(err.to_string().contains("revoked or invalid restore_token"));
    }

    #[test]
    fn initialize_portal_session_recovers_from_revoked_token() {
        let portal = MockRemoteDesktopPortal {
            should_fail_token: true,
        };
        let res = initialize_portal_session(&portal, 3, Some("bad-token"))
            .expect("should recover and succeed on retry without token");
        assert_eq!(res.devices, 3);
        assert_eq!(res.restore_token.as_deref(), Some("new-minted-token-67890"));
    }

    #[test]
    fn initialize_portal_session_succeeds_directly_without_token() {
        let portal = MockRemoteDesktopPortal {
            should_fail_token: false,
        };
        let res = initialize_portal_session(&portal, 3, None)
            .expect("should succeed directly without token");
        assert_eq!(res.devices, 3);
    }

    #[test]
    fn zbus_portal_type_exists() {
        #[cfg(all(target_os = "linux", not(target_env = "musl")))]
        {
            let _ = ZbusRemoteDesktopPortal::new;
        }
    }

    /// Issue #160: the sidecar crashed on Wayland because every `zbus::blocking`
    /// call site runs inside the agent's tokio runtime, and zbus's `tokio`
    /// feature implements `blocking` as `Runtime::block_on` on a shared static
    /// runtime — which tokio rejects from within a runtime ("Cannot start a
    /// runtime from within a runtime"), aborting the process under
    /// `panic = "abort"`.
    ///
    /// This is the minimal reproduction: call a `zbus::blocking` API from
    /// inside `Runtime::block_on`. It must not panic.
    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    #[test]
    fn zbus_blocking_is_safe_inside_a_tokio_runtime() {
        let runtime = tokio::runtime::Runtime::new().expect("build tokio runtime");

        // `catch_unwind` turns the tokio panic into an assertable value: on the
        // pre-fix code this test fails with the runtime-in-runtime panic; after
        // the fix (async-io reactor) it passes. A live session bus is not
        // required — reaching the reactor at all is what used to abort.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            runtime.block_on(async {
                // Errors are fine (no session bus in CI); panics are not.
                let _ = zbus::blocking::Connection::session();
            });
        }));

        assert!(
            outcome.is_ok(),
            "zbus::blocking must not panic when driven from a tokio runtime (Issue #160)"
        );
    }

    /// The real call sites must be reachable from a spawned tokio task without
    /// panicking, which is how `run_with_reconnect` drives the portal.
    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    #[test]
    fn portal_construction_from_spawned_task_does_not_panic() {
        let runtime = tokio::runtime::Runtime::new().expect("build tokio runtime");

        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            runtime.block_on(async {
                let handle = tokio::spawn(async {
                    // Same path `run_with_reconnect` takes before the portal
                    // session is initialized (lib.rs).
                    let _ = ZbusRemoteDesktopPortal::new();
                });
                // A panicking task surfaces as a JoinError; asserting on it is
                // what makes this test able to fail (the bare `let _ =` would
                // swallow the very panic this guards against).
                assert!(
                    handle.await.is_ok(),
                    "portal construction task panicked inside the tokio runtime"
                );
            });
        }));

        assert!(
            outcome.is_ok(),
            "portal construction inside tokio::spawn must not panic (Issue #160)"
        );
    }
}

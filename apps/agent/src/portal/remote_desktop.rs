//! D-Bus `org.freedesktop.portal.RemoteDesktop` & `ScreenCast` client (ADR-90 §5.1).

use anyhow::Result;

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
use anyhow::{bail, Context};

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
    fn select_devices(&self, session: &str, device_mask: u32) -> Result<()>;
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

    fn select_devices(&self, session: &str, device_mask: u32) -> Result<()> {
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
                            streams.push(RemoteDesktopStreamInfo {
                                node_id,
                                width: None,
                                height: None,
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

        fn select_devices(&self, _session: &str, _device_mask: u32) -> Result<()> {
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
            .select_devices(&session, 3)
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
        let _ = portal.select_devices(&session, 3);
        let _ = portal.select_sources(&session, Some("bad-token"));
        let err = portal.start(&session, Some("bad-token")).unwrap_err();
        assert!(err.to_string().contains("revoked or invalid restore_token"));
    }

    #[test]
    fn zbus_portal_type_exists() {
        #[cfg(all(target_os = "linux", not(target_env = "musl")))]
        {
            let _ = ZbusRemoteDesktopPortal::new;
        }
    }
}

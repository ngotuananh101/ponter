//! Native Wayland `PortalInputInjector` implementing `InputInjector` (ADR-90 §5.3).

use crate::input::{Button, InputInjector, KeyModifiers};
use crate::portal::evdev_map::{self, char_to_keysym, map_code_to_evdev};
use anyhow::Result;

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
use anyhow::Context;

pub trait DbusInputNotifier: Send + Sync {
    fn notify_pointer_motion_absolute(&self, stream: u32, x: f64, y: f64) -> Result<()>;
    fn notify_pointer_button(&self, button: i32, state: u32) -> Result<()>;
    fn notify_pointer_axis(&self, dx: f64, dy: f64) -> Result<()>;
    fn notify_keyboard_keycode(&self, keycode: i32, state: u32) -> Result<()>;
    fn notify_keyboard_keysym(&self, keysym: i32, state: u32) -> Result<()>;
}

pub struct PortalInputInjector<N: DbusInputNotifier> {
    stream_id: u32,
    display_width: u32,
    display_height: u32,
    notifier: N,
}

impl<N: DbusInputNotifier> PortalInputInjector<N> {
    pub fn new(stream_id: u32, display_width: u32, display_height: u32, notifier: N) -> Self {
        Self {
            stream_id,
            display_width,
            display_height,
            notifier,
        }
    }
}

impl<N: DbusInputNotifier> InputInjector for PortalInputInjector<N> {
    fn pointer_move(&mut self, x: i32, y: i32) -> Result<()> {
        let clamped_x = x.clamp(0, self.display_width as i32) as f64;
        let clamped_y = y.clamp(0, self.display_height as i32) as f64;
        self.notifier
            .notify_pointer_motion_absolute(self.stream_id, clamped_x, clamped_y)
    }

    fn pointer_button(&mut self, button: Button, pressed: bool) -> Result<()> {
        let btn_code = match button {
            Button::Left => evdev_map::BTN_LEFT as i32,
            Button::Right => evdev_map::BTN_RIGHT as i32,
            Button::Middle => evdev_map::BTN_MIDDLE as i32,
        };
        let state = if pressed { 1 } else { 0 };
        self.notifier.notify_pointer_button(btn_code, state)
    }

    fn wheel(&mut self, dx: i32, dy: i32) -> Result<()> {
        self.notifier.notify_pointer_axis(dx as f64, dy as f64)
    }

    fn key(&mut self, code: &str, pressed: bool, _mods: &KeyModifiers) -> Result<()> {
        if let Some(evdev_code) = map_code_to_evdev(code) {
            let state = if pressed { 1 } else { 0 };
            self.notifier
                .notify_keyboard_keycode(evdev_code as i32, state)
        } else {
            tracing::debug!(code = %code, "ignoring unmapped evdev keycode");
            Ok(())
        }
    }

    fn text(&mut self, text: &str) -> Result<()> {
        for ch in text.chars() {
            let keysym = char_to_keysym(ch) as i32;
            self.notifier.notify_keyboard_keysym(keysym, 1)?;
            self.notifier.notify_keyboard_keysym(keysym, 0)?;
        }
        Ok(())
    }
}

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
pub struct ZbusInputNotifier {
    connection: zbus::blocking::Connection,
    session_handle: String,
}

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
impl ZbusInputNotifier {
    pub fn new(connection: zbus::blocking::Connection, session_handle: String) -> Self {
        Self {
            connection,
            session_handle,
        }
    }

    fn proxy<'a>(&'a self) -> Result<zbus::blocking::Proxy<'a>> {
        zbus::blocking::Proxy::new(
            &self.connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.RemoteDesktop",
        )
        .context("creating RemoteDesktop proxy for input notification")
    }

    fn empty_options() -> std::collections::HashMap<&'static str, zbus::zvariant::Value<'static>> {
        std::collections::HashMap::new()
    }
}

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
impl DbusInputNotifier for ZbusInputNotifier {
    fn notify_pointer_motion_absolute(&self, stream: u32, x: f64, y: f64) -> Result<()> {
        let proxy = self.proxy()?;
        let session_path = zbus::zvariant::ObjectPath::try_from(self.session_handle.as_str())?;
        proxy.call_method(
            "NotifyPointerMotionAbsolute",
            &(session_path, Self::empty_options(), stream, x, y),
        )?;
        Ok(())
    }

    fn notify_pointer_button(&self, button: i32, state: u32) -> Result<()> {
        let proxy = self.proxy()?;
        let session_path = zbus::zvariant::ObjectPath::try_from(self.session_handle.as_str())?;
        proxy.call_method(
            "NotifyPointerButton",
            &(session_path, Self::empty_options(), button, state),
        )?;
        Ok(())
    }

    fn notify_pointer_axis(&self, dx: f64, dy: f64) -> Result<()> {
        let proxy = self.proxy()?;
        let session_path = zbus::zvariant::ObjectPath::try_from(self.session_handle.as_str())?;
        proxy.call_method(
            "NotifyPointerAxis",
            &(session_path, Self::empty_options(), dx, dy),
        )?;
        Ok(())
    }

    fn notify_keyboard_keycode(&self, keycode: i32, state: u32) -> Result<()> {
        let proxy = self.proxy()?;
        let session_path = zbus::zvariant::ObjectPath::try_from(self.session_handle.as_str())?;
        proxy.call_method(
            "NotifyKeyboardKeycode",
            &(session_path, Self::empty_options(), keycode, state),
        )?;
        Ok(())
    }

    fn notify_keyboard_keysym(&self, keysym: i32, state: u32) -> Result<()> {
        let proxy = self.proxy()?;
        let session_path = zbus::zvariant::ObjectPath::try_from(self.session_handle.as_str())?;
        proxy.call_method(
            "NotifyKeyboardKeysym",
            &(session_path, Self::empty_options(), keysym, state),
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::{Button, InputInjector, KeyModifiers};
    use std::sync::{Arc, Mutex};

    #[derive(Default, Clone)]
    struct MockNotifier {
        events: Arc<Mutex<Vec<String>>>,
    }

    impl DbusInputNotifier for MockNotifier {
        fn notify_pointer_motion_absolute(&self, stream: u32, x: f64, y: f64) -> Result<()> {
            self.events
                .lock()
                .unwrap()
                .push(format!("motion:{stream}:{x:.0}:{y:.0}"));
            Ok(())
        }

        fn notify_pointer_button(&self, button: i32, state: u32) -> Result<()> {
            self.events
                .lock()
                .unwrap()
                .push(format!("button:{button:#x}:{state}"));
            Ok(())
        }

        fn notify_pointer_axis(&self, dx: f64, dy: f64) -> Result<()> {
            self.events
                .lock()
                .unwrap()
                .push(format!("axis:{dx:.1}:{dy:.1}"));
            Ok(())
        }

        fn notify_keyboard_keycode(&self, keycode: i32, state: u32) -> Result<()> {
            self.events
                .lock()
                .unwrap()
                .push(format!("key:{keycode}:{state}"));
            Ok(())
        }

        fn notify_keyboard_keysym(&self, keysym: i32, state: u32) -> Result<()> {
            self.events
                .lock()
                .unwrap()
                .push(format!("keysym:{keysym:#x}:{state}"));
            Ok(())
        }
    }

    #[test]
    fn pointer_move_scales_and_emits_motion() {
        let notifier = MockNotifier::default();
        let mut injector = PortalInputInjector::new(42, 1920, 1080, notifier.clone());

        injector.pointer_move(960, 540).expect("pointer move");
        let events = notifier.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], "motion:42:960:540");
    }

    #[test]
    fn pointer_button_translates_evdev_codes() {
        let notifier = MockNotifier::default();
        let mut injector = PortalInputInjector::new(42, 1920, 1080, notifier.clone());

        injector.pointer_button(Button::Left, true).unwrap();
        injector.pointer_button(Button::Right, false).unwrap();

        let events = notifier.events.lock().unwrap();
        assert_eq!(events[0], "button:0x110:1"); // BTN_LEFT press
        assert_eq!(events[1], "button:0x111:0"); // BTN_RIGHT release
    }

    #[test]
    fn wheel_translates_axes() {
        let notifier = MockNotifier::default();
        let mut injector = PortalInputInjector::new(42, 1920, 1080, notifier.clone());

        injector.wheel(0, 120).unwrap();
        let events = notifier.events.lock().unwrap();
        assert_eq!(events[0], "axis:0.0:120.0");
    }

    #[test]
    fn key_translates_evdev_codes() {
        let notifier = MockNotifier::default();
        let mut injector = PortalInputInjector::new(42, 1920, 1080, notifier.clone());

        injector
            .key("KeyA", true, &KeyModifiers::default())
            .unwrap();
        injector
            .key("KeyA", false, &KeyModifiers::default())
            .unwrap();

        let events = notifier.events.lock().unwrap();
        assert_eq!(events[0], "key:30:1");
        assert_eq!(events[1], "key:30:0");
    }

    #[test]
    fn text_emits_keysym_press_and_release() {
        let notifier = MockNotifier::default();
        let mut injector = PortalInputInjector::new(42, 1920, 1080, notifier.clone());

        injector.text("Hi").unwrap();
        let events = notifier.events.lock().unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(events[0], "keysym:0x48:1"); // 'H' press
        assert_eq!(events[1], "keysym:0x48:0"); // 'H' release
        assert_eq!(events[2], "keysym:0x69:1"); // 'i' press
        assert_eq!(events[3], "keysym:0x69:0"); // 'i' release
    }
}

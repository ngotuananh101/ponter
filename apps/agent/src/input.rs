//! Desktop input forwarding: the wire decoder, the normalized→absolute mapping,
//! and the `InputInjector` seam (Week 9, spec §6.1).
//!
//! This module is **not** `cfg`-gated: it holds only serde types, pure
//! functions, and a trait — no injection dependency — so it compiles on every
//! target exactly as `pty.rs` does. Only the concrete injector is
//! `cfg(not(target_env = "musl"))` (spec §6.1).

use anyhow::{Context, Result};

use crate::desktop::DesktopSourceInfo;

/// The pointer button on the wire (spec §2.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    Left,
    Middle,
    Right,
}

/// Keyboard modifier state (spec §2.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
pub struct KeyModifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

/// One decoded input event, mirroring the TS `DesktopInput` union (spec §6.1).
#[derive(Debug, Clone, PartialEq)]
pub enum DesktopInput {
    PointerMove {
        x: f64,
        y: f64,
    },
    PointerButton {
        button: Button,
        pressed: bool,
        x: f64,
        y: f64,
    },
    Wheel {
        dx: f64,
        dy: f64,
        x: f64,
        y: f64,
    },
    Key {
        code: String,
        pressed: bool,
        modifiers: KeyModifiers,
    },
    Text {
        text: String,
    },
}

/// The seam that makes the gate and the tests possible without a display
/// (ADR-27, ADR-29). One platform implementation sits behind it.
pub trait InputInjector: Send {
    fn pointer_move(&mut self, x: i32, y: i32) -> Result<()>;
    fn pointer_button(&mut self, button: Button, pressed: bool) -> Result<()>;
    fn wheel(&mut self, dx: i32, dy: i32) -> Result<()>;
    fn key(&mut self, code: &str, pressed: bool, mods: &KeyModifiers) -> Result<()>;
    fn text(&mut self, text: &str) -> Result<()>;
}

/// The raw payload of a `desktop-input` frame (spec §2.2). The `kind` tag
/// selects which fields are read; serde's internally-tagged enum does the
/// discrimination, so an unknown `kind` is a decode error.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum DesktopInputWire {
    PointerMove {
        x: f64,
        y: f64,
        #[serde(default)]
        seq: Option<u64>,
    },
    PointerButton {
        button: Button,
        pressed: bool,
        x: f64,
        y: f64,
        #[serde(default)]
        seq: Option<u64>,
    },
    Wheel {
        dx: f64,
        dy: f64,
        x: f64,
        y: f64,
        #[serde(default)]
        seq: Option<u64>,
    },
    Key {
        code: String,
        pressed: bool,
        #[serde(default)]
        modifiers: KeyModifiers,
    },
    Text {
        text: String,
    },
}

/// ADR-43: agent-side cap on accepted `desktop-input` frames per fixed
/// one-second window. 120 = 2× the browser's 60 Hz coalescing
/// (`desktop-core` `inputRateLimitHz`), so a well-behaved client is never
/// throttled while a flooding peer is capped. A `const`, not a CLI flag
/// (YAGNI); revisit only if a real workload needs tuning.
pub const INPUT_RATE_CAP_HZ: u32 = 120;

/// Fixed-window rate limiter for `desktop-input` frames (ADR-43).
///
/// `allow(now_ms)` admits at most `max_per_sec` calls whose `now_ms` falls in
/// the same one-second window (`now_ms.div_euclid(1_000)`; euclidean, so the
/// windows stay contiguous across zero and no window is skipped). The first
/// call of a new window resets the count. Deterministic and clock-injectable,
/// so the exact 120/window math is unit-testable without a display or a real
/// clock.
pub struct InputRateLimiter {
    max_per_sec: u32,
    window_index: i64,
    count: u32,
}

impl InputRateLimiter {
    pub fn new(max_per_sec: u32) -> Self {
        Self {
            max_per_sec,
            window_index: -1, // no window yet: the first call always initializes
            count: 0,
        }
    }

    /// Returns `true` iff the frame is admitted. A `false` means the caller
    /// must drop the frame (the dispatcher logs the drop at `debug`).
    pub fn allow(&mut self, now_ms: i64) -> bool {
        let window = now_ms.div_euclid(1_000);
        if window != self.window_index {
            self.window_index = window;
            self.count = 0;
        }
        if self.count >= self.max_per_sec {
            return false;
        }
        self.count += 1;
        true
    }
}

fn clamp01(n: f64) -> f64 {
    if n.is_nan() {
        0.0
    } else {
        n.clamp(0.0, 1.0)
    }
}

/// One decoded input frame: the event plus the envelope's `timestamp`
/// (browser `Date.now()` ms). ADR-44 carries the timestamp out of the single
/// parse so the success path can log `delta_ms` without re-parsing the frame.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedDesktopInput {
    pub event: DesktopInput,
    pub timestamp_ms: i64,
    pub seq: Option<u64>,
}

/// Decode an inbound `desktop-input` frame (spec §6.1).
///
/// Same guard shape as `decode_pty_input` (`pty.rs:124`): a size cap checked
/// **before** parsing, then a strict channel/type match. Returns `Ok(None)` for
/// a frame that is not a `desktop-input` on the `control` channel; `Err` when it
/// is but cannot be decoded. Unlike the terminal path the payload is **JSON,
/// not base64** — input is structured, so the reuse is the guard *shape*.
pub fn decode_desktop_input(raw: &str) -> Result<Option<DecodedDesktopInput>> {
    if raw.len() > crate::pty::MAX_FRAME_BYTES {
        anyhow::bail!(
            "inbound frame exceeds {} bytes",
            crate::pty::MAX_FRAME_BYTES
        );
    }
    let envelope: crate::pty::DataChannelMessage<serde_json::Value> =
        serde_json::from_str(raw).context("inbound frame is not a DataChannelMessage")?;
    if envelope.channel != "control" || envelope.r#type != "desktop-input" {
        return Ok(None);
    }
    let wire: DesktopInputWire =
        serde_json::from_value(envelope.payload).context("payload is not a DesktopInput")?;
    let (event, seq) = match wire {
        DesktopInputWire::PointerMove { x, y, seq } => (
            DesktopInput::PointerMove {
                x: clamp01(x),
                y: clamp01(y),
            },
            seq,
        ),
        DesktopInputWire::PointerButton {
            button,
            pressed,
            x,
            y,
            seq,
        } => (
            DesktopInput::PointerButton {
                button,
                pressed,
                x: clamp01(x),
                y: clamp01(y),
            },
            seq,
        ),
        DesktopInputWire::Wheel { dx, dy, x, y, seq } => (
            DesktopInput::Wheel {
                dx,
                dy,
                x: clamp01(x),
                y: clamp01(y),
            },
            seq,
        ),
        DesktopInputWire::Key {
            code,
            pressed,
            modifiers,
        } => (
            DesktopInput::Key {
                code,
                pressed,
                modifiers,
            },
            None,
        ),
        DesktopInputWire::Text { text } => (DesktopInput::Text { text }, None),
    };
    Ok(Some(DecodedDesktopInput {
        event,
        timestamp_ms: envelope.timestamp,
        seq,
    }))
}

/// Map a normalized (0..1) point to absolute source pixels (spec §6.2, ADR-30).
///
/// `abs = source.x + round(n * source.dimension)`, clamped to the source rect.
/// `scaleFactor` is applied here if the injector's unit differs from xcap's
/// (spec §3.4 — a recorded watch item, settled by Task 1's spike or left to the
/// concrete injector).
pub fn to_absolute(nx: f64, ny: f64, source: &DesktopSourceInfo) -> (i32, i32) {
    let x = source.x + (clamp01(nx) * source.width as f64).round() as i32;
    let y = source.y + (clamp01(ny) * source.height as f64).round() as i32;
    (x, y)
}

/// Apply one frame to the injector iff the gate is open (spec §6.3).
///
/// Returns `Some(seq)` iff an event was injected, echoing the browser-assigned
/// `seq` from the frame so the cursor layer can report round-trip latency
/// (ADR-47). `None` for a closed gate, a non-input frame, a decode error, or an
/// injector error — the caller continues the session (spec §6.3, §9.4). Pure
/// over its inputs except for the injector, so the gate is unit-testable
/// without a display.
pub fn apply_if_allowed(
    allow_input: bool,
    raw: &str,
    source: &DesktopSourceInfo,
    injector: &mut dyn InputInjector,
    now_ms: i64,
) -> Option<u64> {
    if !allow_input {
        tracing::debug!("dropping desktop-input: input disabled");
        return None;
    }
    let decoded = match decode_desktop_input(raw) {
        Ok(Some(decoded)) => decoded,
        Ok(None) => return None,
        Err(e) => {
            tracing::debug!(error = %e, "dropping a malformed desktop-input frame");
            return None;
        }
    };
    let result = match decoded.event {
        DesktopInput::PointerMove { x, y } => {
            let (ax, ay) = to_absolute(x, y, source);
            injector.pointer_move(ax, ay)
        }
        DesktopInput::PointerButton {
            button,
            pressed,
            x,
            y,
        } => {
            // Move first so the click lands on the intended point.
            let (ax, ay) = to_absolute(x, y, source);
            injector
                .pointer_move(ax, ay)
                .and_then(|()| injector.pointer_button(button, pressed))
        }
        DesktopInput::Wheel { dx, dy, x, y } => {
            let (ax, ay) = to_absolute(x, y, source);
            injector
                .pointer_move(ax, ay)
                .and_then(|()| injector.wheel(dx as i32, dy as i32))
        }
        DesktopInput::Key {
            code,
            pressed,
            modifiers,
        } => injector.key(&code, pressed, &modifiers),
        DesktopInput::Text { text } => injector.text(&text),
    };
    match result {
        Ok(()) => {
            // ADR-44: the positive injection signal. `.max(0)` keeps a
            // zero/future envelope timestamp from logging a negative delta
            // (the envelope timestamp is attacker-influenced); `now_ms` is
            // passed in so the caller keeps the clock seam testable.
            tracing::info!(
                delta_ms = (now_ms - decoded.timestamp_ms).max(0),
                "desktop-input applied"
            );
            decoded.seq
        }
        Err(e) => {
            tracing::debug!(error = %e, "dropping desktop-input after an injector error");
            None
        }
    }
}

/// The concrete injector, chosen by the ADR-27 spike (Task 1: **enigo**).
/// Non-musl only: the musl artifact is terminal-only and never opens a desktop
/// session (spec §1.2, ADR-15). Enigo is `Send`, so it fits `InputInjector`
/// behind a `Box<dyn>` with no wrapper.
#[cfg(not(target_env = "musl"))]
pub mod platform {
    use super::*;

    pub struct PlatformInjector {
        inner: enigo::Enigo,
    }

    impl PlatformInjector {
        /// Created lazily on the first *allowed* input frame — a host with no
        /// display must not fail the stream merely because input is enabled
        /// (spec §6.3).
        pub fn try_new() -> Result<Self> {
            // On macOS the default pops a GUI permission prompt on first use;
            // the ADR-27 finding says turn it off (the prompt is not ours to
            // trigger from a headless agent).
            #[cfg(target_os = "macos")]
            let settings = enigo::Settings {
                open_prompt_to_get_permissions: false,
                ..enigo::Settings::default()
            };
            #[cfg(not(target_os = "macos"))]
            let settings = enigo::Settings::default();
            Ok(Self {
                inner: enigo::Enigo::new(&settings)?,
            })
        }
    }

    impl InputInjector for PlatformInjector {
        fn pointer_move(&mut self, x: i32, y: i32) -> Result<()> {
            use enigo::Mouse;
            self.inner.move_mouse(x, y, enigo::Coordinate::Abs)?;
            Ok(())
        }
        fn pointer_button(&mut self, button: Button, pressed: bool) -> Result<()> {
            use enigo::{Button as E, Direction, Mouse};
            let b = match button {
                Button::Left => E::Left,
                Button::Middle => E::Middle,
                Button::Right => E::Right,
            };
            self.inner.button(
                b,
                if pressed {
                    Direction::Press
                } else {
                    Direction::Release
                },
            )?;
            Ok(())
        }
        fn wheel(&mut self, dx: i32, dy: i32) -> Result<()> {
            use enigo::Mouse;
            if dy != 0 {
                self.inner.scroll(dy, enigo::Axis::Vertical)?;
            }
            if dx != 0 {
                self.inner.scroll(dx, enigo::Axis::Horizontal)?;
            }
            Ok(())
        }
        fn key(&mut self, code: &str, pressed: bool, _mods: &KeyModifiers) -> Result<()> {
            use enigo::{Direction, Keyboard};
            // `code` is a physical KeyboardEvent.code; `map_code` (below) is the
            // one code→enigo::Key table. Modifier state is not replayed — the
            // browser sends the modifier keys themselves as `key` frames
            // (ADR-28), so enigo sees the real press/release order.
            let Some(key) = map_code(code) else {
                tracing::debug!(code, "unknown KeyboardEvent.code; dropping key frame");
                return Ok(());
            };
            self.inner.key(
                key,
                if pressed {
                    Direction::Press
                } else {
                    Direction::Release
                },
            )?;
            Ok(())
        }
        fn text(&mut self, text: &str) -> Result<()> {
            use enigo::Keyboard;
            self.inner.text(text)?;
            Ok(())
        }
    }

    /// Physical `KeyboardEvent.code` → `enigo::Key` (ADR-28). Letters and digits
    /// map through `Key::Unicode`; the common control/navigation keys use their
    /// dedicated variants. `None` for an unknown code, which the caller logs and
    /// drops (fail-soft, spec §6.3).
    ///
    /// **Do not replace the `Unicode` path with `enigo::Key::A`..`Key::Z` or a
    /// `Digit0`..`Digit9` variant.** In enigo 0.6.1 the letter variants are
    /// `#[cfg(target_os = "windows")]`-only (referencing them on Linux/macOS
    /// does not compile) and there is **no** `DigitN` variant at all. Routing
    /// printable characters through `Unicode` is the only mapping that compiles
    /// on all five agent targets.
    fn map_code(code: &str) -> Option<enigo::Key> {
        use enigo::Key;
        // Printable single characters → `Unicode` (see the doc note above). This
        // covers letters, digits, AND punctuation: enigo has no cross-platform
        // named variant for `,` `.` `/` etc. (`OEMComma`/`OEMPeriod`/`OEMMinus`
        // are `#[cfg(target_os = "windows")]`-only), so `Unicode` is the only
        // mapping that compiles everywhere. The frame's `modifiers` are NOT
        // replayed here — the browser sends the modifier keys themselves as
        // `key` frames (ADR-28), so enigo sees the real order.
        let ch = match code {
            "KeyA" => 'a',
            "KeyB" => 'b',
            "KeyC" => 'c',
            "KeyD" => 'd',
            "KeyE" => 'e',
            "KeyF" => 'f',
            "KeyG" => 'g',
            "KeyH" => 'h',
            "KeyI" => 'i',
            "KeyJ" => 'j',
            "KeyK" => 'k',
            "KeyL" => 'l',
            "KeyM" => 'm',
            "KeyN" => 'n',
            "KeyO" => 'o',
            "KeyP" => 'p',
            "KeyQ" => 'q',
            "KeyR" => 'r',
            "KeyS" => 's',
            "KeyT" => 't',
            "KeyU" => 'u',
            "KeyV" => 'v',
            "KeyW" => 'w',
            "KeyX" => 'x',
            "KeyY" => 'y',
            "KeyZ" => 'z',
            "Digit0" => '0',
            "Digit1" => '1',
            "Digit2" => '2',
            "Digit3" => '3',
            "Digit4" => '4',
            "Digit5" => '5',
            "Digit6" => '6',
            "Digit7" => '7',
            "Digit8" => '8',
            "Digit9" => '9',
            // Punctuation. Without these, `,` `.` `/` `;` `'` `` ` `` `[` `]`
            // `\` `-` `=` would hit `_ => return None` and be silently dropped —
            // a real gap when typing into a text field. (`!` `@` `(` … still
            // arrive via Shift+Digit, so only the unshifted punctuation is here.)
            "Comma" => ',',
            "Period" => '.',
            "Slash" => '/',
            "Semicolon" => ';',
            "Quote" => '\'',
            "Backquote" => '`',
            "BracketLeft" => '[',
            "BracketRight" => ']',
            "Backslash" => '\\',
            "Minus" => '-',
            "Equal" => '=',
            _ => '\0',
        };
        if ch != '\0' {
            return Some(Key::Unicode(ch));
        }

        // Fixed keys with dedicated cross-platform enigo variants. The
        // right-hand modifiers are the `R*` variants (`RShift`/`RControl`).
        let key = match code {
            "Enter" => Key::Return,
            "Escape" => Key::Escape,
            "Backspace" => Key::Backspace,
            "Tab" => Key::Tab,
            "Space" => Key::Space,
            "Delete" => Key::Delete,
            "ArrowUp" => Key::UpArrow,
            "ArrowDown" => Key::DownArrow,
            "ArrowLeft" => Key::LeftArrow,
            "ArrowRight" => Key::RightArrow,
            "Home" => Key::Home,
            "End" => Key::End,
            "PageUp" => Key::PageUp,
            "PageDown" => Key::PageDown,
            "ShiftLeft" => Key::Shift,
            "ShiftRight" => Key::RShift,
            "ControlLeft" => Key::Control,
            "ControlRight" => Key::RControl,
            "AltLeft" | "AltRight" => Key::Alt,
            "MetaLeft" | "MetaRight" => Key::Meta,
            "CapsLock" => Key::CapsLock,
            _ => return None,
        };
        Some(key)
    }

    #[cfg(test)]
    mod tests {
        use super::map_code;
        use enigo::Key;

        #[test]
        fn map_code_routes_letters_and_digits_through_unicode() {
            // Letters/digits MUST go through `Key::Unicode`: `enigo::Key::A` is
            // `#[cfg(target_os = "windows")]`-only and there is no `DigitN`
            // variant, so `Key::A`/`Key::Digit0` would not compile on Linux or
            // macOS. Do not "optimise" this back to the letter variants.
            assert_eq!(map_code("KeyA"), Some(Key::Unicode('a')));
            assert_eq!(map_code("Digit3"), Some(Key::Unicode('3')));
            // Punctuation also goes through `Unicode` (no cross-platform named
            // variant exists) — without it `,` `.` `=` etc. would be dropped.
            assert_eq!(map_code("Comma"), Some(Key::Unicode(',')));
            assert_eq!(map_code("Equal"), Some(Key::Unicode('=')));
            // Named keys use their dedicated cross-platform variants; the
            // right-hand modifiers are the `R*` ones.
            assert_eq!(map_code("Enter"), Some(Key::Return));
            assert_eq!(map_code("ShiftLeft"), Some(Key::Shift));
            assert_eq!(map_code("ShiftRight"), Some(Key::RShift));
            assert_eq!(map_code("ControlRight"), Some(Key::RControl));
            assert_eq!(map_code("CapsLock"), Some(Key::CapsLock));
            // Unknown codes fail soft (drop, not panic) — spec §6.3.
            assert_eq!(map_code("Nope"), None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> crate::desktop::DesktopSourceInfo {
        crate::desktop::DesktopSourceInfo {
            id: "monitor:1".to_string(),
            kind: crate::desktop::SourceKind::Monitor,
            name: "eDP-1".to_string(),
            width: 1920,
            height: 1080,
            x: 100, // non-zero origin on purpose (§6.2)
            y: 50,
            scale_factor: 1.0,
            rotation: 0.0,
            is_primary: true,
            default: true,
        }
    }

    fn frame(payload: serde_json::Value) -> String {
        serde_json::json!({
            "type": "desktop-input",
            "channel": "control",
            "payload": payload,
            "timestamp": 0,
        })
        .to_string()
    }

    #[test]
    fn decode_returns_the_envelope_timestamp_alongside_the_event() {
        // The frame() helper stamps `timestamp: 0`; a dedicated frame pins a
        // non-zero value so a swap of the two fields cannot pass.
        let raw = serde_json::json!({
            "type": "desktop-input",
            "channel": "control",
            "payload": { "kind": "pointer-move", "x": 0.25, "y": 0.5 },
            "timestamp": 1_726_000_000_123_i64,
        })
        .to_string();
        let decoded = decode_desktop_input(&raw).unwrap().unwrap();
        assert_eq!(decoded.timestamp_ms, 1_726_000_000_123);
        assert_eq!(decoded.event, DesktopInput::PointerMove { x: 0.25, y: 0.5 });
    }

    #[test]
    fn zero_timestamp_is_carried_verbatim() {
        // Envelope timestamps are attacker-influenced; 0 must decode as 0,
        // not as a sentinel or an error.
        let decoded = decode_desktop_input(&frame(
            serde_json::json!({ "kind": "pointer-move", "x": 0.0, "y": 0.0 }),
        ))
        .unwrap()
        .unwrap();
        assert_eq!(decoded.timestamp_ms, 0);
    }

    #[test]
    fn apply_clamps_a_future_timestamp_to_a_zero_delta() {
        // A timestamp in the future (clock skew / hostile peer) would make the
        // delta negative; it must clamp to 0, never go negative or panic.
        let future = serde_json::json!({
            "type": "desktop-input",
            "channel": "control",
            "payload": { "kind": "pointer-move", "x": 0.5, "y": 0.5, "seq": 1 },
            "timestamp": 5_000,
        })
        .to_string();
        let mut injector = CountingInjector::default();
        // now_ms = 1_000 < timestamp 5_000 → the raw delta is -4000.
        let applied = apply_if_allowed(true, &future, &source(), &mut injector, 1_000);
        assert_eq!(applied, Some(1));
        assert_eq!(
            injector
                .pointer_moves
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[test]
    fn decodes_every_kind() {
        let move_ev = decode_desktop_input(&frame(
            serde_json::json!({ "kind": "pointer-move", "x": 0.5, "y": 0.25 }),
        ))
        .unwrap()
        .map(|d| d.event);
        assert_eq!(move_ev, Some(DesktopInput::PointerMove { x: 0.5, y: 0.25 }));

        let btn = decode_desktop_input(&frame(serde_json::json!({ "kind": "pointer-button", "button": "left", "pressed": true, "x": 0.5, "y": 0.5 })))
            .unwrap().map(|d| d.event);
        assert_eq!(
            btn,
            Some(DesktopInput::PointerButton {
                button: Button::Left,
                pressed: true,
                x: 0.5,
                y: 0.5
            })
        );

        let wheel = decode_desktop_input(&frame(
            serde_json::json!({ "kind": "wheel", "dx": 0.0, "dy": -1.0, "x": 0.1, "y": 0.1 }),
        ))
        .unwrap()
        .map(|d| d.event);
        assert_eq!(
            wheel,
            Some(DesktopInput::Wheel {
                dx: 0.0,
                dy: -1.0,
                x: 0.1,
                y: 0.1
            })
        );

        let key = decode_desktop_input(&frame(serde_json::json!({ "kind": "key", "code": "KeyA", "pressed": true, "modifiers": { "ctrl": true, "alt": false, "shift": false, "meta": false } })))
            .unwrap().map(|d| d.event);
        assert!(
            matches!(key, Some(DesktopInput::Key { ref code, pressed: true, .. }) if code == "KeyA")
        );

        let text =
            decode_desktop_input(&frame(serde_json::json!({ "kind": "text", "text": "hi" })))
                .unwrap()
                .map(|d| d.event);
        assert_eq!(
            text,
            Some(DesktopInput::Text {
                text: "hi".to_string()
            })
        );
    }

    #[test]
    fn clamps_normalized_coordinates_at_decode() {
        let ev = decode_desktop_input(&frame(
            serde_json::json!({ "kind": "pointer-move", "x": 2.5, "y": -1.0 }),
        ))
        .unwrap()
        .map(|d| d.event);
        assert_eq!(ev, Some(DesktopInput::PointerMove { x: 1.0, y: 0.0 }));
    }

    #[test]
    fn ignores_a_foreign_channel_or_type() {
        let wrong_channel = serde_json::json!({
            "type": "desktop-input", "channel": "terminal",
            "payload": { "kind": "text", "text": "x" }, "timestamp": 0,
        })
        .to_string();
        assert_eq!(decode_desktop_input(&wrong_channel).unwrap(), None);

        let wrong_type = serde_json::json!({
            "type": "desktop-select", "channel": "control",
            "payload": { "sourceId": "monitor:1" }, "timestamp": 0,
        })
        .to_string();
        assert_eq!(decode_desktop_input(&wrong_type).unwrap(), None);
    }

    #[test]
    fn rejects_an_oversize_frame_before_parsing() {
        // A frame larger than MAX_FRAME_BYTES must Err on size, not on parse.
        let huge = "x".repeat(crate::pty::MAX_FRAME_BYTES + 1);
        assert!(decode_desktop_input(&huge).is_err());
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(decode_desktop_input("{not json").is_err());
    }

    #[test]
    fn maps_normalized_to_absolute_with_a_nonzero_origin() {
        // source.x=100, width=1920 → 0.5 lands at 100 + 960 = 1060.
        assert_eq!(to_absolute(0.5, 0.5, &source()), (100 + 960, 50 + 540));
        // Clamp: out-of-range input is already clamped at decode, but the pure
        // function must not overflow the source rect either.
        assert_eq!(to_absolute(0.0, 0.0, &source()), (100, 50));
        assert_eq!(to_absolute(1.0, 1.0, &source()), (100 + 1920, 50 + 1080));
    }

    /// A test double so the gate is provable without a display (spec §6.5).
    #[derive(Default)]
    struct CountingInjector {
        pointer_moves: std::sync::atomic::AtomicUsize,
        keys: std::sync::atomic::AtomicUsize,
        fail_next: std::sync::atomic::AtomicBool,
    }
    impl InputInjector for CountingInjector {
        fn pointer_move(&mut self, _x: i32, _y: i32) -> anyhow::Result<()> {
            self.pointer_moves
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self
                .fail_next
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                anyhow::bail!("injected failure");
            }
            Ok(())
        }
        fn pointer_button(&mut self, _b: Button, _p: bool) -> anyhow::Result<()> {
            Ok(())
        }
        fn wheel(&mut self, _dx: i32, _dy: i32) -> anyhow::Result<()> {
            Ok(())
        }
        fn key(&mut self, _c: &str, _p: bool, _m: &KeyModifiers) -> anyhow::Result<()> {
            self.keys.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
        fn text(&mut self, _t: &str) -> anyhow::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn gate_closed_injects_nothing() {
        // The dispatcher's gate is `cfg.allow_input`; this pins the *decision*
        // function so the gate is unit-tested, not only E2E (spec §6.5).
        let mut injector = CountingInjector::default();
        let mut applied = 0usize;
        for _ in 0..10 {
            if apply_if_allowed(
                false,
                &frame(serde_json::json!({ "kind": "pointer-move", "x": 0.5, "y": 0.5 })),
                &source(),
                &mut injector,
                0,
            )
            .is_some()
            {
                applied += 1;
            }
        }
        assert_eq!(applied, 0);
        assert_eq!(
            injector
                .pointer_moves
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
    }

    #[test]
    fn gate_open_injects_once_with_the_mapped_point() {
        let mut injector = CountingInjector::default();
        let applied = apply_if_allowed(
            true,
            &frame(serde_json::json!({ "kind": "pointer-move", "x": 0.5, "y": 0.5, "seq": 2 })),
            &source(),
            &mut injector,
            0,
        );
        assert_eq!(applied, Some(2));
        assert_eq!(
            injector
                .pointer_moves
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[test]
    fn injector_error_is_fail_soft() {
        let mut injector = CountingInjector::default();
        injector
            .fail_next
            .store(true, std::sync::atomic::Ordering::SeqCst);
        // Returns None (nothing applied) but does NOT panic/Err out.
        let applied = apply_if_allowed(
            true,
            &frame(serde_json::json!({ "kind": "pointer-move", "x": 0.5, "y": 0.5 })),
            &source(),
            &mut injector,
            0,
        );
        assert!(applied.is_none());
    }

    #[test]
    fn rate_limiter_admits_exactly_the_cap_in_one_window() {
        let mut limiter = super::InputRateLimiter::new(120);
        // A fixed window admits exactly 120 frames, then drops.
        let admitted = (0..120).filter(|_| limiter.allow(1_000)).count();
        assert_eq!(admitted, 120);
        assert!(!limiter.allow(1_000));
    }

    #[test]
    fn rate_limiter_rolls_over_on_the_next_window() {
        let mut limiter = super::InputRateLimiter::new(120);
        for _ in 0..120 {
            assert!(limiter.allow(1_000));
        }
        assert!(!limiter.allow(1_999)); // still window 0
        assert!(limiter.allow(2_000)); // window 1
    }

    #[test]
    fn rate_limiter_admits_the_first_call_at_the_zero_window() {
        // The zero window must not be mistaken for "already rolled over": the
        // very first call at now_ms=0 is admitted, and with a cap of 1 the
        // second call in the same window is rejected. (The -1 initializer and a
        // 0 initializer are behaviorally equivalent here; the sentinel just
        // makes "no window yet" explicit.)
        let mut limiter = super::InputRateLimiter::new(1);
        assert!(limiter.allow(0));
        assert!(!limiter.allow(0));
    }

    #[test]
    fn rate_limiter_counts_drops_within_a_window() {
        // Spec §6: the limiter must "count drops" — 130 calls in one window
        // admit exactly the 120 cap and reject the remaining 10.
        let mut limiter = super::InputRateLimiter::new(120);
        let mut admitted = 0u32;
        let mut dropped = 0u32;
        for _ in 0..130 {
            if limiter.allow(1_000) {
                admitted += 1;
            } else {
                dropped += 1;
            }
        }
        assert_eq!(admitted, 120);
        assert_eq!(dropped, 10);
    }

    #[test]
    fn decode_preserves_optional_input_seq() {
        let raw = r#"{"type":"desktop-input","channel":"control","payload":{"kind":"pointer-move","x":0.5,"y":0.25,"seq":123},"timestamp":100}"#;
        let decoded = decode_desktop_input(raw).unwrap().unwrap();
        assert_eq!(decoded.seq, Some(123));
    }

    #[test]
    fn apply_returns_applied_input_seq() {
        let raw = r#"{"type":"desktop-input","channel":"control","payload":{"kind":"pointer-move","x":0.5,"y":0.25,"seq":456},"timestamp":100}"#;
        let mut injector = CountingInjector::default();
        let src = source();
        let echoed = apply_if_allowed(true, raw, &src, &mut injector, 100);
        assert_eq!(echoed, Some(456));
    }
}

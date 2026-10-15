//! Evdev keycode & X11 keysym translation table for Linux portal input (ADR-90 §5.3).

pub const BTN_LEFT: u32 = 0x110;
pub const BTN_RIGHT: u32 = 0x111;
pub const BTN_MIDDLE: u32 = 0x112;

/// Maps a W3C KeyboardEvent.code string to the corresponding Linux evdev keycode.
pub fn map_code_to_evdev(code: &str) -> Option<u32> {
    match code {
        // Alphanumeric keys
        "KeyA" => Some(30),
        "KeyB" => Some(48),
        "KeyC" => Some(46),
        "KeyD" => Some(32),
        "KeyE" => Some(18),
        "KeyF" => Some(33),
        "KeyG" => Some(34),
        "KeyH" => Some(35),
        "KeyI" => Some(23),
        "KeyJ" => Some(36),
        "KeyK" => Some(37),
        "KeyL" => Some(38),
        "KeyM" => Some(50),
        "KeyN" => Some(49),
        "KeyO" => Some(24),
        "KeyP" => Some(25),
        "KeyQ" => Some(16),
        "KeyR" => Some(19),
        "KeyS" => Some(31),
        "KeyT" => Some(20),
        "KeyU" => Some(22),
        "KeyV" => Some(47),
        "KeyW" => Some(17),
        "KeyX" => Some(45),
        "KeyY" => Some(21),
        "KeyZ" => Some(44),

        // Digits
        "Digit1" => Some(2),
        "Digit2" => Some(3),
        "Digit3" => Some(4),
        "Digit4" => Some(5),
        "Digit5" => Some(6),
        "Digit6" => Some(7),
        "Digit7" => Some(8),
        "Digit8" => Some(9),
        "Digit9" => Some(10),
        "Digit0" => Some(11),

        // Modifiers
        "ShiftLeft" => Some(42),
        "ShiftRight" => Some(54),
        "ControlLeft" => Some(29),
        "ControlRight" => Some(97),
        "AltLeft" => Some(56),
        "AltRight" => Some(100),
        "MetaLeft" => Some(125),
        "MetaRight" => Some(126),

        // Navigation and system keys
        "Escape" => Some(1),
        "Backspace" => Some(14),
        "Tab" => Some(15),
        "Enter" => Some(28),
        "Space" => Some(57),
        "CapsLock" => Some(58),
        "ArrowUp" => Some(103),
        "ArrowLeft" => Some(105),
        "ArrowRight" => Some(106),
        "ArrowDown" => Some(108),
        "Home" => Some(102),
        "End" => Some(107),
        "PageUp" => Some(104),
        "PageDown" => Some(109),
        "Insert" => Some(110),
        "Delete" => Some(111),

        // Function keys
        "F1" => Some(59),
        "F2" => Some(60),
        "F3" => Some(61),
        "F4" => Some(62),
        "F5" => Some(63),
        "F6" => Some(64),
        "F7" => Some(65),
        "F8" => Some(66),
        "F9" => Some(67),
        "F10" => Some(68),
        "F11" => Some(87),
        "F12" => Some(88),

        // Punctuation and symbols
        "Minus" => Some(12),
        "Equal" => Some(13),
        "BracketLeft" => Some(26),
        "BracketRight" => Some(27),
        "Backslash" => Some(43),
        "Semicolon" => Some(39),
        "Quote" => Some(40),
        "Backquote" => Some(41),
        "Comma" => Some(51),
        "Period" => Some(52),
        "Slash" => Some(53),

        // Numpad
        "Numpad0" => Some(82),
        "Numpad1" => Some(79),
        "Numpad2" => Some(80),
        "Numpad3" => Some(81),
        "Numpad4" => Some(75),
        "Numpad5" => Some(76),
        "Numpad6" => Some(77),
        "Numpad7" => Some(71),
        "Numpad8" => Some(72),
        "Numpad9" => Some(73),
        "NumpadEnter" => Some(96),
        "NumpadAdd" => Some(78),
        "NumpadSubtract" => Some(74),
        "NumpadMultiply" => Some(55),
        "NumpadDivide" => Some(98),
        "NumpadDecimal" => Some(83),

        _ => None,
    }
}

/// Converts a Unicode character to an X11 Keysym for D-Bus NotifyKeyboardKeysym.
pub fn char_to_keysym(ch: char) -> u32 {
    match ch {
        '\n' | '\r' => 0xFF0D, // XK_Return
        '\t' => 0xFF09,        // XK_Tab
        '\x08' => 0xFF08,      // XK_BackSpace
        '\x1B' => 0xFF1B,      // XK_Escape
        '\x7F' => 0xFFFF,      // XK_Delete
        c if (c as u32) <= 0x00FF => c as u32,
        c => 0x0100_0000 | (c as u32), // Direct Unicode keysym prefix
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letter_keys_map_correctly() {
        assert_eq!(map_code_to_evdev("KeyA"), Some(30));
        assert_eq!(map_code_to_evdev("KeyB"), Some(48));
        assert_eq!(map_code_to_evdev("KeyQ"), Some(16));
        assert_eq!(map_code_to_evdev("KeyZ"), Some(44));
    }

    #[test]
    fn digit_keys_map_correctly() {
        assert_eq!(map_code_to_evdev("Digit1"), Some(2));
        assert_eq!(map_code_to_evdev("Digit9"), Some(10));
        assert_eq!(map_code_to_evdev("Digit0"), Some(11));
    }

    #[test]
    fn navigation_and_control_keys_map_correctly() {
        assert_eq!(map_code_to_evdev("Escape"), Some(1));
        assert_eq!(map_code_to_evdev("Backspace"), Some(14));
        assert_eq!(map_code_to_evdev("Tab"), Some(15));
        assert_eq!(map_code_to_evdev("Enter"), Some(28));
        assert_eq!(map_code_to_evdev("Space"), Some(57));
        assert_eq!(map_code_to_evdev("ArrowUp"), Some(103));
        assert_eq!(map_code_to_evdev("ArrowDown"), Some(108));
        assert_eq!(map_code_to_evdev("ArrowLeft"), Some(105));
        assert_eq!(map_code_to_evdev("ArrowRight"), Some(106));
        assert_eq!(map_code_to_evdev("Home"), Some(102));
        assert_eq!(map_code_to_evdev("End"), Some(107));
        assert_eq!(map_code_to_evdev("PageUp"), Some(104));
        assert_eq!(map_code_to_evdev("PageDown"), Some(109));
        assert_eq!(map_code_to_evdev("Delete"), Some(111));
    }

    #[test]
    fn modifier_keys_map_correctly() {
        assert_eq!(map_code_to_evdev("ShiftLeft"), Some(42));
        assert_eq!(map_code_to_evdev("ShiftRight"), Some(54));
        assert_eq!(map_code_to_evdev("ControlLeft"), Some(29));
        assert_eq!(map_code_to_evdev("ControlRight"), Some(97));
        assert_eq!(map_code_to_evdev("AltLeft"), Some(56));
        assert_eq!(map_code_to_evdev("AltRight"), Some(100));
        assert_eq!(map_code_to_evdev("MetaLeft"), Some(125));
        assert_eq!(map_code_to_evdev("MetaRight"), Some(126));
    }

    #[test]
    fn function_and_symbol_keys_map_correctly() {
        assert_eq!(map_code_to_evdev("F1"), Some(59));
        assert_eq!(map_code_to_evdev("F12"), Some(88));
        assert_eq!(map_code_to_evdev("Minus"), Some(12));
        assert_eq!(map_code_to_evdev("Equal"), Some(13));
        assert_eq!(map_code_to_evdev("Slash"), Some(53));
    }

    #[test]
    fn numpad_keys_map_correctly() {
        assert_eq!(map_code_to_evdev("Numpad0"), Some(82));
        assert_eq!(map_code_to_evdev("NumpadEnter"), Some(96));
    }

    #[test]
    fn mouse_button_constants_match_linux_input_event_codes() {
        assert_eq!(BTN_LEFT, 0x110);
        assert_eq!(BTN_RIGHT, 0x111);
        assert_eq!(BTN_MIDDLE, 0x112);
    }

    #[test]
    fn unknown_key_returns_none() {
        assert_eq!(map_code_to_evdev("UnrecognizedKeyXYZ"), None);
        assert_eq!(map_code_to_evdev(""), None);
    }

    #[test]
    fn ascii_char_to_keysym_mapping() {
        assert_eq!(char_to_keysym('a'), 0x61);
        assert_eq!(char_to_keysym('A'), 0x41);
        assert_eq!(char_to_keysym(' '), 0x20);
        assert_eq!(char_to_keysym('\n'), 0xFF0D); // Return keysym
        assert_eq!(char_to_keysym('\r'), 0xFF0D); // Return keysym
        assert_eq!(char_to_keysym('\t'), 0xFF09); // Tab keysym
        assert_eq!(char_to_keysym('\x08'), 0xFF08); // Backspace
        assert_eq!(char_to_keysym('\x1B'), 0xFF1B); // Escape
        assert_eq!(char_to_keysym('\x7F'), 0xFFFF); // Delete
    }

    #[test]
    fn unicode_char_to_keysym_mapping() {
        // Unicode character above Latin-1 (e.g., Vietnamese 'ơ' = U+01A1)
        assert_eq!(char_to_keysym('ơ'), 0x0100_01A1);
    }
}

//! Agent-side cursor polling (ADR-45, spec §6.2).
//!
//! Samples the root pointer position and cursor shape, converts the shape to a
//! capped base64 PNG, and emits a `DesktopCursorPayload` only when the position
//! or the shape serial has changed.
//!
//! The pure helpers and wire structs are ungated so the module compiles on every
//! target (CI builds Windows and macOS too); only the X11 backend is cfg-gated
//! to `unix` + non-musl.

use crate::desktop::{DesktopCursorPayload, DesktopShape, DesktopSourceInfo};

// `base64::Engine` provides the `.encode()` method on `STANDARD`.
use base64::Engine;

/// The maximum number of bytes a base64-encoded cursor PNG may occupy on the
/// wire. 32 KiB is ADR-45's cap — any shape whose base64 exceeds this is
/// omitted entirely (the cursor is still reported, just shape-less).
#[allow(dead_code)]
pub const CURSOR_PNG_B64_CAP: usize = 32768;

/// One cursor position sample in normalized source coordinates.
#[allow(dead_code)]
pub struct CursorSample {
    pub x: f64,
    pub y: f64,
    pub visible: bool,
}

/// Maps absolute root coordinates to normalized 0..1 within `source`.
///
/// A cursor outside `[source.x, source.x+width) x [source.y, source.y+height)`
/// yields `visible=false` with coords clamped into 0..1.
#[allow(dead_code)]
pub fn map_cursor_to_source(root_x: i32, root_y: i32, source: &DesktopSourceInfo) -> CursorSample {
    let sx = source.x as f64;
    let sy = source.y as f64;
    let sw = source.width as f64;
    let sh = source.height as f64;
    let inside = root_x >= source.x
        && root_y >= source.y
        && (root_x as u32) < (source.x as u32 + source.width)
        && (root_y as u32) < (source.y as u32 + source.height);
    if !inside {
        CursorSample {
            x: 0.0,
            y: 0.0,
            visible: false,
        }
    } else {
        let nx = ((root_x as f64) - sx) / sw;
        let ny = ((root_y as f64) - sy) / sh;
        CursorSample {
            x: nx.clamp(0.0, 1.0),
            y: ny.clamp(0.0, 1.0),
            visible: true,
        }
    }
}

/// RGBA bytes -> base64 PNG shape. Returns `None` only on PNG-encode failure.
///
/// Does NOT apply the size cap — that is `filter_shape_by_cap`'s job.
#[allow(dead_code)]
pub fn encode_cursor_shape(
    rgba: &[u8],
    width: u32,
    height: u32,
    hotspot_x: u32,
    hotspot_y: u32,
    serial: u32,
) -> Option<DesktopShape> {
    use image::codecs::png::PngEncoder;
    use image::ImageEncoder;
    use std::io::Cursor;

    // Validate the buffer length before encoding; PngEncoder::write_image
    // panics on a mismatch (it asserts `buffer.len() == width * height * 4`).
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4));
    match expected {
        Some(n) if rgba.len() == n => {}
        _ => return None,
    }

    let mut out: Vec<u8> = Vec::new();
    let encoder = PngEncoder::new(Cursor::new(&mut out));
    encoder
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .ok()?;
    let png = base64::engine::general_purpose::STANDARD.encode(&out);
    Some(DesktopShape {
        png,
        hotspot_x,
        hotspot_y,
        serial,
    })
}

/// Returns `None` when the `png` string exceeds `CURSOR_PNG_B64_CAP`; passthrough
/// otherwise.
#[allow(dead_code)]
pub fn filter_shape_by_cap(shape: Option<DesktopShape>) -> Option<DesktopShape> {
    match shape {
        Some(s) if s.png.len() > CURSOR_PNG_B64_CAP => None,
        other => other,
    }
}

/// Convert XFixes ARGB pixels (0xAARRGGBB) into a flat RGBA byte buffer.
#[allow(dead_code)]
fn argb_to_rgba(pixels: &[u32]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(pixels.len() * 4);
    for p in pixels {
        rgba.push((p & 0xff) as u8); // R
        rgba.push(((p >> 8) & 0xff) as u8); // G
        rgba.push(((p >> 16) & 0xff) as u8); // B
        rgba.push(((p >> 24) & 0xff) as u8); // A
    }
    rgba
}

/// X11 cursor sampler using XFixes. Non-musl unix only: X11 does not exist on
/// musl (terminal-only artifact) and is absent on macOS/Windows.
#[cfg(all(unix, not(target_os = "macos"), not(target_env = "musl")))]
pub mod platform {
    use super::*;
    use anyhow::{Context, Result};
    use x11rb::connection::Connection;
    use x11rb::protocol::xfixes;
    use x11rb::protocol::xproto;
    use x11rb::rust_connection::RustConnection;

    /// A sampler that reads cursor state from the X11 root window.
    #[allow(dead_code)]
    pub struct X11CursorSampler {
        conn: RustConnection,
        root: x11rb::protocol::xproto::Window,
        // screen_num is captured for diagnostics but not needed after connect.
        _screen_num: usize,
    }

    impl X11CursorSampler {
        /// Connects to the default X11 display (`$DISPLAY`).
        ///
        /// Returns `Err` when no display is available — the caller logs and
        /// keeps the last sample rather than panicking.
        #[allow(dead_code)]
        pub fn connect() -> Result<Self> {
            let (conn, screen_num) = x11rb::connect(None).context("connecting to X11")?;
            let root = conn
                .setup()
                .roots
                .get(screen_num)
                .context("X11 setup has no root for the screen")?
                .root;
            Ok(Self {
                conn,
                root,
                _screen_num: screen_num,
            })
        }

        /// One sample of cursor position + image from XFixes.
        ///
        /// Returns a `CursorSampleRaw` with the root coordinates, the cursor
        /// serial, and — when non-zero — the ARGB pixels converted to RGBA.
        #[allow(dead_code)]
        pub fn sample(&self) -> Result<CursorSampleRaw> {
            // Position: query_pointer returns root_x/i16 in root-window coords.
            // `reply()` converts the protocol reply (or error) into a typed
            // `QueryPointerReply`; an error on the socket surfaces as an `Err`.
            let pointer = xproto::query_pointer(&self.conn, self.root)
                .context("query_pointer")?
                .reply();

            // Shape: get_cursor_image delivers the ARGB pixels directly.
            let img = xfixes::get_cursor_image(&self.conn)
                .context("get_cursor_image")?
                .reply()?;

            let (root_x, root_y) = match pointer {
                Ok(r) => (r.root_x as i32, r.root_y as i32),
                Err(e) => {
                    // If we can't read the pointer position, fall back to the
                    // cursor image's coordinates (xfixes reports x,y too).
                    tracing::warn!(error = %e, "query_pointer failed; using cursor image coordinates");
                    (img.x as i32, img.y as i32)
                }
            };

            let serial = img.cursor_serial;
            let (w, h, xhot, yhot) = (
                img.width as u32,
                img.height as u32,
                img.xhot as u32,
                img.yhot as u32,
            );
            let rgba = if serial == 0 || img.cursor_image.is_empty() {
                Vec::new()
            } else {
                argb_to_rgba(&img.cursor_image)
            };

            Ok(CursorSampleRaw {
                root_x,
                root_y,
                serial,
                rgba,
                width: w,
                height: h,
                hotspot_x: xhot,
                hotspot_y: yhot,
            })
        }
    }

    /// The raw fields pulled off the wire before normalization.
    #[allow(dead_code)]
    pub struct CursorSampleRaw {
        pub root_x: i32,
        pub root_y: i32,
        pub serial: u32,
        pub rgba: Vec<u8>,
        pub width: u32,
        pub height: u32,
        pub hotspot_x: u32,
        pub hotspot_y: u32,
    }

    /// A cursor poller that samples X11 via XFixes and emits a payload only on
    /// change.
    #[allow(dead_code)]
    pub struct CursorPoller {
        sampler: X11CursorSampler,
        /// The source this cursor is mapped to.
        source: DesktopSourceInfo,
        /// The last serial we emitted a payload for; drives the dirty check.
        last_serial: u32,
        /// The last position we emitted a payload for; drives the dirty check.
        last_x: f64,
        last_y: f64,
        /// Monotonic counter over emitted samples (ADR-45).
        seq: u64,
    }

    impl CursorPoller {
        /// Builds a poller that maps the cursor onto `source`. The source is
        /// borrowed by value (it is small and cheaply cloned) so the poller owns
        /// a stable snapshot rather than a borrow that must outlive the loop.
        #[allow(dead_code)]
        pub fn new(sampler: X11CursorSampler, source: DesktopSourceInfo) -> Self {
            Self {
                sampler,
                source,
                last_serial: 0,
                last_x: 0.0,
                last_y: 0.0,
                seq: 0,
            }
        }

        /// Sample the cursor and produce a payload if the position or the shape
        /// serial changed since the last emission.
        ///
        /// `last_input_seq` is left `None` — Task 12 fills it from the input
        /// forwarding layer.
        #[allow(dead_code)]
        pub fn poll(&mut self) -> Result<Option<DesktopCursorPayload>> {
            let raw = match self.sampler.sample() {
                Ok(raw) => raw,
                Err(e) => {
                    tracing::warn!(error = %e, "cursor sample failed; skipping this tick");
                    return Ok(None);
                }
            };

            let mapped = map_cursor_to_source(raw.root_x, raw.root_y, &self.source);

            // Dirty-check: only emit when position OR shape serial changed.
            // The first poll always emits (initial state: last_x=0, last_y=0,
            // last_serial=0 — any real sample differs from this sentinel).
            let position_changed =
                (mapped.x - self.last_x).abs() > 0.0 || (mapped.y - self.last_y).abs() > 0.0;
            let shape_changed = raw.serial != self.last_serial;

            if !position_changed && !shape_changed {
                return Ok(None);
            }

            // Emit. The visibility bit is driven by whether the cursor is inside
            // the source rect; a shape is only encoded when there is a non-zero
            // serial AND actual pixel data.
            let shape = if raw.serial != 0 && !raw.rgba.is_empty() {
                let encoded = encode_cursor_shape(
                    &raw.rgba,
                    raw.width,
                    raw.height,
                    raw.hotspot_x,
                    raw.hotspot_y,
                    raw.serial,
                );
                filter_shape_by_cap(encoded)
            } else {
                None
            };

            let payload = DesktopCursorPayload {
                x: mapped.x,
                y: mapped.y,
                visible: mapped.visible,
                seq: self.seq,
                last_input_seq: None,
                shape,
            };
            self.seq += 1;
            self.last_x = mapped.x;
            self.last_y = mapped.y;
            self.last_serial = raw.serial;
            Ok(Some(payload))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::{DesktopSourceInfo, SourceKind};

    /// Mirrors the `source()` helper in `input.rs` — full field list, no
    /// `Default` derive (spec §6.2; `DesktopSourceInfo` has no `Default`).
    fn source() -> DesktopSourceInfo {
        DesktopSourceInfo {
            id: "monitor:1".to_string(),
            kind: SourceKind::Monitor,
            name: "eDP-1".to_string(),
            width: 800,
            height: 600,
            x: 100,
            y: 100,
            scale_factor: 1.0,
            rotation: 0.0,
            is_primary: true,
            default: false,
        }
    }

    #[test]
    fn map_cursor_inside_source_is_normalized_and_visible() {
        let src = source();
        // Inside: (500, 400) → (0.5, 0.5)
        let s = map_cursor_to_source(500, 400, &src);
        assert!(s.visible);
        assert!((s.x - 0.5).abs() < 1e-6);
        assert!((s.y - (300.0 / 600.0)).abs() < 1e-6);
    }

    #[test]
    fn map_cursor_origin_is_zero() {
        let src = source();
        let s = map_cursor_to_source(100, 100, &src);
        assert!(s.visible);
        assert_eq!(s.x, 0.0);
        assert_eq!(s.y, 0.0);
    }

    #[test]
    fn map_cursor_far_corner_approaches_one() {
        let src = source();
        // Inside the last pixel: (100+800-1, 100+600-1) = (899, 699).
        // Normalized: (799/800, 599/600) ≈ (0.99875, 0.99833) — close to 1.0
        // but not exactly, because the range is [x, x+width) (exclusive upper).
        let s = map_cursor_to_source(899, 699, &src);
        assert!(s.visible);
        assert!((s.x - 799.0 / 800.0).abs() < 1e-6);
        assert!((s.y - 599.0 / 600.0).abs() < 1e-6);
    }

    #[test]
    fn map_cursor_outside_source_is_invisible_and_clamped() {
        let src = source();
        // Top-left outside.
        let s = map_cursor_to_source(50, 50, &src);
        assert!(!s.visible);
        assert_eq!(s.x, 0.0);
        assert_eq!(s.y, 0.0);

        // Right of the source.
        let s = map_cursor_to_source(2000, 400, &src);
        assert!(!s.visible);
        assert_eq!(s.x, 0.0);
        assert_eq!(s.y, 0.0);

        // Below the source.
        let s = map_cursor_to_source(500, 2000, &src);
        assert!(!s.visible);
        assert_eq!(s.x, 0.0);
        assert_eq!(s.y, 0.0);
    }

    #[test]
    fn map_cursor_negative_is_invisible() {
        let src = source();
        let s = map_cursor_to_source(-100, -100, &src);
        assert!(!s.visible);
        assert_eq!(s.x, 0.0);
        assert_eq!(s.y, 0.0);
    }

    /// All-white 2x2 image. The PNG must decode back to those exact pixels.
    #[test]
    fn encode_cursor_shape_round_trips_a_small_icon() {
        let rgba = vec![
            255u8, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let shape = encode_cursor_shape(&rgba, 2, 2, 1, 1, 42).expect("encode succeeds");
        assert_eq!(shape.hotspot_x, 1);
        assert_eq!(shape.hotspot_y, 1);
        assert_eq!(shape.serial, 42);
        // Decode the PNG and check the pixels.
        let png_bytes = base64::engine::general_purpose::STANDARD
            .decode(&shape.png)
            .expect("base64 decode");
        let img = image::load_from_memory(&png_bytes).expect("png decode");
        let pixels = img.to_rgba8();
        assert_eq!(pixels[(0, 0)].0, [255, 0, 0, 255]);
        assert_eq!(pixels[(1, 0)].0, [0, 255, 0, 255]);
        assert_eq!(pixels[(0, 1)].0, [0, 0, 255, 255]);
        assert_eq!(pixels[(1, 1)].0, [255, 255, 255, 255]);
    }

    #[test]
    fn encode_cursor_shape_returns_none_on_wrong_byte_count() {
        // 5 bytes for a 2x2 RGBA image (needs 16 bytes) cannot encode.
        let bad = vec![255u8; 5];
        assert!(encode_cursor_shape(&bad, 2, 2, 0, 0, 1).is_none());
    }

    /// A 200×200 noisy image produces a base64 PNG that exceeds the 32 KiB cap,
    /// so `filter_shape_by_cap` must drop it. (A solid-color PNG would be tiny;
    /// random data forces the encoder to emit a large payload.)
    #[test]
    fn test_cursor_png_size_cap_omits_shape() {
        let mut rng = 0u32;
        let noisy_rgba: Vec<u8> = (0..200 * 200 * 4)
            .map(|_| {
                rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
                (rng >> 16) as u8
            })
            .collect();
        let noisy_shape = encode_cursor_shape(&noisy_rgba, 200, 200, 0, 0, 1)
            .expect("noisy 200x200 PNG must encode");
        assert!(
            noisy_shape.png.len() > CURSOR_PNG_B64_CAP,
            "the noisy PNG must exceed the cap (got {} bytes)",
            noisy_shape.png.len()
        );
        assert!(
            filter_shape_by_cap(Some(noisy_shape)).is_none(),
            "a shape over the cap must be filtered out"
        );
    }

    #[test]
    fn filter_shape_by_cap_passes_a_small_shape_through() {
        let rgba = vec![
            255u8, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let shape = encode_cursor_shape(&rgba, 2, 2, 0, 0, 1).expect("encode");
        assert_eq!(
            shape.png.len(),
            filter_shape_by_cap(Some(shape.clone())).unwrap().png.len()
        );
    }

    #[test]
    fn filter_shape_by_cap_returns_none_for_none() {
        assert!(filter_shape_by_cap(None).is_none());
    }

    /// ARGB → RGBA byte order: XFixes delivers 0xAARRGGBB where the low byte is R.
    /// Per the brief: emit [r, g, b, a] = (p & 0xff), (p>>8 & 0xff), (p>>16 & 0xff),
    /// (p>>24 & 0xff).
    #[test]
    fn argb_to_rgba_correct_byte_order() {
        // 0xAARRGGBB with A=0xAA, R=0xDD, G=0xCC, B=0xBB per the brief's convention.
        let pixel: u32 = 0xAABBCCDD;
        let rgba = argb_to_rgba(&[pixel]);
        assert_eq!(rgba, vec![0xDD, 0xCC, 0xBB, 0xAA]);
    }

    #[test]
    fn argb_to_rgba_multipixel() {
        let pixels = [0xFF112233, 0x80445566, 0x00778899];
        let rgba = argb_to_rgba(&pixels);
        assert_eq!(
            rgba,
            vec![
                0x33, 0x22, 0x11, 0xFF, // 0xFF112233 → R=33 G=22 B=11 A=FF
                0x66, 0x55, 0x44, 0x80, // 0x80445566 → R=66 G=55 B=44 A=80
                0x99, 0x88, 0x77, 0x00, // 0x00778899 → R=99 G=88 B=77 A=00
            ]
        );
    }

    #[test]
    fn test_cursor_outside_source_is_invisible() {
        let source = DesktopSourceInfo {
            id: "monitor:1".to_string(),
            kind: SourceKind::Monitor,
            name: "Test".to_string(),
            width: 800,
            height: 600,
            x: 100,
            y: 100,
            scale_factor: 1.0,
            rotation: 0.0,
            is_primary: true,
            default: true,
        };
        let sample = map_cursor_to_source(50, 50, &source);
        assert!(!sample.visible);
    }
}

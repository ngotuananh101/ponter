# Phase 7 L0 — Tauri Shell Embedding Feasibility Spike

- **Date:** 2026-10-07
- **Status:** PASS
- **Gate:** ADR-50 (agent runtime embedding in a Tauri shell on Linux)
- **Environment:** Fedora 44, Rust 1.98.1, Node v24.21.0, pnpm 12.6.0, Xvfb

---

## 1. Tauri version resolved

| Component | Version | Source |
|---|---|---|
| `tauri` crate | 2.12.1 | `Cargo.lock` |
| `tauri-cli` | 2.12.1 | `pnpm exec tauri --version` |
| `tauri-build` | 2.7.1 | `Cargo.lock` |
| `tauri-runtime` / `tauri-runtime-wry` | 2.12.1 | `Cargo.lock` |
| `tauri-utils` | 2.10.1 | `Cargo.lock` |
| `tauri-plugin-opener` | 2.7.0 | `Cargo.lock` |

The `tauri` and `tauri-cli` crate versions are in sync (both 2.12.1).

---

## 2. Linux system dependencies required

The following Fedora 44 packages are required for a Tauri 2.x app using WebKitGTK
on this machine. The system already had `gtk3-devel` (GTK 3.24.52); the rest were
supplied via a local prefix at `/tmp/tauri-spike-deps/root` (see §5 for why).

### Packages that must be installed on a fresh system

| Package | Purpose |
|---|---|
| `webkit2gtk4.1` | WebKitGTK webview runtime (web content engine) |
| `webkit2gtk4.1-devel` | WebKitGTK headers + pkgconfig (`webkit2gtk-4.1.pc`), needed by `webkit2gtk-sys` bindgen |
| `javascriptcoregtk4.1` | JavaScriptCore engine runtime |
| `javascriptcoregtk4.1-devel` | JavaScriptCore headers + pkgconfig (`javascriptcoregtk-4.1.pc`) |
| `libsoup3` | HTTP library used by WebKitGTK |
| `libsoup3-devel` | libsoup3 headers + pkgconfig (`libsoup-3.0.pc`) |
| `sqlite3` / `sqlite-devel` | SQLite, used by libsoup3 (Requires.private) |
| `libpsl-devel` | Public Suffix List library, used by libsoup3 |
| `krb5-devel` | Kerberos GSSAPI, used by libsoup3 (Requires.private `krb5-gssapi`) |
| `libnghttp2-devel` | HTTP/2 support, used by libsoup3 (Requires.private `libnghttp2`) |

### Packages already present on this machine (system-installed)

| Package | Version | Purpose |
|---|---|---|
| `gtk3-devel` | 3.24.52 | GTK 3 toolkit development files |
| `glib2-devel` | 2.88.3 | GLib C library (glib-2.0, gobject-2.0, gio-2.0, gmodule) |
| `brotli` (libs) | system | libbrotlidec, pulled by libsoup3 Requires.private |
| `zlib` (libs) | system | zlib, pulled by libsoup3 Requires.private |
| `sysprof-capture-4` | system | sysprof-capture, pulled by libsoup3 Requires.private |
| `dbus-1` | 1.16.2 | D-Bus, used by GTK |
| `libmount` / `libblkid` | system | filesystem mount info, used by glib/gio |
| `wayland-client` / `wayland-cursor` / `wayland-egl` | 1.26.0 | Wayland protocol (Tauri uses X11/Wayland via wry/tao) |
| `cairo` | 1.18.6 | 2D graphics, used by GTK |
| `pango` | 1.57.1 | Text layout, used by GTK |
| `atk` | 2.60.7 | Accessibility toolkit, used by GTK |
| `gdk-pixbuf2-devel` | 2.44.4 | Image loading, used by GTK |
| `harfbuzz` | 14.1.0 | Text shaping, used by cairo/pango |

### Complete `dnf` install line for CI (Task 10)

```bash
dnf install -y \
  webkit2gtk4.1 webkit2gtk4.1-devel \
  javascriptcoregtk4.1 javascriptcoregtk4.1-devel \
  libsoup3 libsoup3-devel \
  sqlite-devel libpsl-devel krb5-devel libnghttp2-devel \
  gtk3-devel glib2-devel
```

(The `gtk3-devel` and `glib2-devel` are already installed on this machine;
include them on the CI image for completeness.)

---

## 3. Exact boot command that worked

```bash
# Environment exports (required before any cargo/tauri build):
export PKG_CONFIG_PATH="/tmp/tauri-spike-deps/root/usr/lib64/pkgconfig:/tmp/tauri-spike-deps/root/usr/share/pkgconfig"
export LIBRARY_PATH="/tmp/tauri-spike-deps/root/usr/lib64"

# Start virtual framebuffer:
Xvfb :99 -screen 0 1280x1024x24 &

# Build (from apps/desktop):
DISPLAY=:99 pnpm exec tauri build

# Run the built binary headless:
DISPLAY=:99 timeout 40 ./src-tauri/target/release/ponter_desktop
```

---

## 4. Observed evidence

### Build (compile + link) — (a) PASS

Excerpt from `task-1-evidence/tauri-build.log` (the `$` line echoes the command;
the log also records the frontend `pnpm build` step, omitted here):

```
$ DISPLAY=:99 pnpm exec tauri build
   Compiling ponter_desktop v0.1.0 (.../src-tauri)
    Finished `release` profile [optimized] target(s) in 1m 10s
       Built application at: .../src-tauri/target/release/ponter_desktop
```

No WebKitGTK link error, no `capture-stack` undefined reference, no undefined
symbols. The Rust side compiles and links cleanly.

### Process starts + creates webview — (b) PASS

Running the binary under `DISPLAY=:99` with `RUST_LOG=debug`, the glycin
image-loader D-Bus service activates (proving the GTK/webview stack initialized),
and the process stays alive for the full timeout:

```
[2026-10-07T15:48:26.952Z DEBUG glycin::sandbox] bwrap sandboxing available: true
[2026-10-07T15:48:26.961Z DEBUG glycin::dbus] Loader stderr: ... Creating zbus connection to glycin
```

### spike_start invoked in-process — (c) PASS

With a temporary `eprintln!` added to the Rust `spike_start` command (removed
before commit), the binary emits:

```
[spike] backend command spike_start invoked
```

This proves the Tauri invoke handler dispatched `spike_start` to the Rust
backend and it executed in-process. (The frontend's `console.log` output
`[spike] backend command spike_start returned: runtime start requested` is
written to the webview console, which is not capturable in a headless run;
the Rust-side `eprintln!` is the equivalent in-process proof.)

---

## 5. No-sudo local-prefix workaround

This machine (Fedora 44) has the WebKitGTK **runtime** packages but NOT the
`-devel` packages, and there is no passwordless sudo. A local prefix was
prepared at `/tmp/tauri-spike-deps/root` by extracting the RPM payloads and
rewriting the `*.pc` paths so `pkg-config` and the linker can find
`webkit2gtk-4.1`.

**Rebuild recipe** (if `/tmp/tauri-spike-deps/root` is missing, e.g. after
/tmp cleanup):

```bash
PREFIX=/tmp/tauri-spike-deps/root
RPMS=/tmp/tauri-spike-deps
rm -rf "$PREFIX"; mkdir -p "$PREFIX"; cd "$RPMS"
dnf download --destdir "$RPMS" --arch x86_64 \
  webkit2gtk4.1-devel javascriptcoregtk4.1-devel libsoup3-devel \
  sqlite-devel libpsl-devel krb5-devel libnghttp2-devel
for r in *.x86_64.rpm; do rpm2cpio "$r" | (cd "$PREFIX" && cpio -idm --quiet); done
for pc in "$PREFIX"/usr/lib64/pkgconfig/*.pc "$PREFIX"/usr/share/pkgconfig/*.pc; do
  sed -i "s|^prefix=/usr$|prefix=$PREFIX/usr|" "$pc"; done
for so in libwebkit2gtk-4.1.so.0 libjavascriptcoregtk-4.1.so.0 libsoup-3.0.so.0; do
  ln -sf "/usr/lib64/$so" "$PREFIX/usr/lib64/$so"; done
```

Then export before any Rust build:

```bash
export PKG_CONFIG_PATH="/tmp/tauri-spike-deps/root/usr/lib64/pkgconfig:/tmp/tauri-spike-deps/root/usr/share/pkgconfig"
export LIBRARY_PATH="/tmp/tauri-spike-deps/root/usr/lib64"
```

**Note for CI:** CI does not need this workaround — it should `dnf install`
the `-devel` packages listed in §2 instead.

---

## 6. Verdict

**PASS** — Tauri 2.12.1 embeds a webview via WebKitGTK on Linux, compiles and
links without errors, boots the process under Xvfb, and the `spike_start`
backend command executes in-process. ADR-50 is validated; L1 may proceed.

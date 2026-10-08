//! Per-platform auto-start (ADR-55, Task 8).
//!
//! The platform launch entry IS the source of truth (R3) — no stored boolean
//! preference. `set_autostart` installs/removes the entry; `is_autostart_enabled`
//! reports whether it exists. All three platforms take effect at the **next
//! login** (no immediate launch) — see R12 honesty notes.
//!
//! Pure render fns + injectable file helpers are unit-tested on Linux (R6/R10).
//! The `#[tauri::command]` wrappers that touch `current_exe()` / spawn `reg.exe`
//! are NOT unit-tested against real OS state — their building blocks are (R7).
//!
//! No new crates (R2): Linux/macOS use `std::fs`/`std::path`; Windows uses
//! `reg.exe` via `std::process::Command`.

use std::path::{Path, PathBuf};

/// Linux XDG autostart filename.
pub const LINUX_ENTRY_FILE: &str = "ponter-desktop.desktop";
/// macOS LaunchAgent label.
pub const MACOS_LABEL: &str = "com.ponter.desktop";
/// macOS LaunchAgent filename.
pub const MACOS_ENTRY_FILE: &str = "com.ponter.desktop.plist";
/// Windows `Run` registry value name.
pub const WINDOWS_RUN_VALUE: &str = "PonterDesktop";
/// Windows `Run` registry key path (raw string so backslashes are literal).
pub const WINDOWS_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

/// Linux XDG autostart dir. XDG_CONFIG_HOME (non-blank) wins, else HOME/.config,
/// else "./.config".
pub fn linux_autostart_dir(xdg_config_home: Option<&str>, home: Option<&str>) -> PathBuf {
    if let Some(x) = xdg_config_home {
        if !x.trim().is_empty() {
            return PathBuf::from(x);
        }
    }
    if let Some(h) = home {
        if !h.trim().is_empty() {
            let mut p = PathBuf::from(h);
            p.push(".config");
            return p;
        }
    }
    PathBuf::from(".").join(".config")
}

/// macOS LaunchAgents dir. HOME/Library/LaunchAgents, else "./Library/LaunchAgents".
pub fn macos_launch_agents_dir(home: Option<&str>) -> PathBuf {
    if let Some(h) = home {
        if !h.trim().is_empty() {
            let mut p = PathBuf::from(h);
            p.push("Library");
            p.push("LaunchAgents");
            return p;
        }
    }
    PathBuf::from(".").join("Library").join("LaunchAgents")
}

/// The Linux `.desktop` file body (pure). Quotes Exec when the path has spaces.
pub fn render_linux_desktop_entry(binary: &Path) -> String {
    let binary_str = binary.to_string_lossy();
    let exec = if binary_str.contains(' ') {
        format!("\"{binary_str}\"")
    } else {
        binary_str.to_string()
    };
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Ponter Desktop\n\
         Exec={exec}\n\
         X-GNOME-Autostart-enabled=true\n\
         Terminal=false\n\
         Comment=Start Ponter Desktop agent on login\n"
    )
}

/// The macOS LaunchAgent plist body (pure).
pub fn render_macos_plist(binary: &Path) -> String {
    let binary_str = binary.to_string_lossy().replace('\t', "\\t");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \t<key>Label</key>\n\
         \t<string>{MACOS_LABEL}</string>\n\
         \t<key>ProgramArguments</key>\n\
         \t<array>\n\
         \t\t<string>{binary_str}</string>\n\
         \t</array>\n\
         \t<key>RunAtLoad</key>\n\
         \t<true/>\n\
         </dict>\n\
         </plist>\n"
    )
}

/// argv for `reg.exe` to install the Run value (pure; no "reg.exe" element — the
/// caller sets the program). Produces:
/// `add HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v PonterDesktop /t REG_SZ /d <binary> /f`
pub fn windows_run_add_args(binary: &Path) -> Vec<String> {
    let binary_str = binary.to_string_lossy();
    vec![
        "add".to_string(),
        WINDOWS_RUN_KEY.to_string(),
        "/v".to_string(),
        WINDOWS_RUN_VALUE.to_string(),
        "/t".to_string(),
        "REG_SZ".to_string(),
        "/d".to_string(),
        binary_str.to_string(),
        "/f".to_string(),
    ]
}

/// argv for `reg.exe` to remove the Run value (pure). Produces:
/// `delete HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v PonterDesktop /f`
pub fn windows_run_delete_args() -> Vec<String> {
    vec![
        "delete".to_string(),
        WINDOWS_RUN_KEY.to_string(),
        "/v".to_string(),
        WINDOWS_RUN_VALUE.to_string(),
        "/f".to_string(),
    ]
}

/// Write `contents` to `<dir>/<filename>` (creating `dir` if needed).
pub fn write_entry(dir: &Path, filename: &str, contents: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("could not create autostart dir {dir:?}: {e}"))?;
    std::fs::write(dir.join(filename), contents)
        .map_err(|e| format!("could not write autostart entry {dir:?}/{filename}: {e}"))?;
    Ok(())
}

/// Remove `<dir>/<filename>`; Ok if it did not exist.
pub fn remove_entry(dir: &Path, filename: &str) -> Result<(), String> {
    let path = dir.join(filename);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not remove autostart entry {path:?}: {e}")),
    }
}

/// Whether `<dir>/<filename>` exists.
pub fn entry_exists(dir: &Path, filename: &str) -> bool {
    dir.join(filename).exists()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Install or remove the platform-native auto-start entry.
///
/// Takes effect on the **next login** — no immediate launch (R12).
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    let binary =
        std::env::current_exe().map_err(|e| format!("could not resolve current exe: {e}"))?;
    let (dir, filename) = resolve_autostart_location();
    set_autostart_in(&binary, &dir, filename, enabled)
}

/// The Linux XDG autostart **entry** dir — the config dir plus the `autostart`
/// subdir. XDG desktop environments only discover `.desktop` entries inside
/// `autostart/` (ADR-55 / R4: `~/.config/autostart/*.desktop`). `linux_autostart_dir`
/// keeps its R5 contract (base config dir); the caller appends the subdir here so
/// the real command writes where the desktop actually looks.
#[cfg(target_os = "linux")]
fn linux_autostart_entry_dir(xdg_config_home: Option<&str>, home: Option<&str>) -> PathBuf {
    linux_autostart_dir(xdg_config_home, home).join("autostart")
}

/// Resolve the platform-specific autostart directory and filename (R3 — the
/// entry IS the source of truth; no stored boolean).
#[cfg(target_os = "linux")]
fn resolve_autostart_location() -> (PathBuf, &'static str) {
    let home = std::env::var("HOME").ok();
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    (
        linux_autostart_entry_dir(xdg.as_deref(), home.as_deref()),
        LINUX_ENTRY_FILE,
    )
}

#[cfg(target_os = "macos")]
fn resolve_autostart_location() -> (PathBuf, &'static str) {
    let home = std::env::var("HOME").ok();
    (macos_launch_agents_dir(home.as_deref()), MACOS_ENTRY_FILE)
}

/// Windows has no file-based entry: `set_autostart_in`/`is_autostart_enabled_in`
/// ignore the dir/filename and drive `reg.exe` against `WINDOWS_RUN_KEY`. Return a
/// documented placeholder; the returned value name mirrors the registry value
/// (`WINDOWS_RUN_VALUE`) so the tuple stays meaningful to callers.
#[cfg(windows)]
fn resolve_autostart_location() -> (PathBuf, &'static str) {
    (PathBuf::new(), WINDOWS_RUN_VALUE)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn resolve_autostart_location() -> (PathBuf, &'static str) {
    (PathBuf::from("."), LINUX_ENTRY_FILE)
}

/// `set_autostart` helper with injectable binary path + dir/filename — used by
/// tests that must not write to the real user config.
fn set_autostart_in(
    binary: &Path,
    dir: &Path,
    filename: &str,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = filename;
        let contents = render_linux_desktop_entry(binary);
        if enabled {
            write_entry(dir, LINUX_ENTRY_FILE, &contents)
        } else {
            remove_entry(dir, LINUX_ENTRY_FILE)
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = filename;
        let contents = render_macos_plist(binary);
        if enabled {
            write_entry(dir, MACOS_ENTRY_FILE, &contents)
        } else {
            remove_entry(dir, MACOS_ENTRY_FILE)
        }
    }

    #[cfg(windows)]
    {
        let _ = dir;
        let _ = filename;
        let binary_str = binary.to_string_lossy().to_string();
        let (subargs, desc) = if enabled {
            (windows_run_add_args(binary), "add Run value")
        } else {
            (windows_run_delete_args(), "remove Run value")
        };
        let output = std::process::Command::new("reg.exe")
            .args(&subargs)
            .output()
            .map_err(|e| format!("failed to spawn reg.exe to {desc}: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("reg.exe {desc} failed: {stderr}"));
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = binary;
        let _ = enabled;
        Err("auto-start is not supported on this platform".to_string())
    }
}

/// Whether the platform-native auto-start entry is currently installed.
///
/// Returns `false` on any resolution error (documented — an unreadable entry
/// is treated as "not enabled"). Never panics (R7). Takes effect at the next
/// login; this reflects the entry's presence, not a running process.
#[tauri::command]
pub fn is_autostart_enabled() -> bool {
    let Ok(binary) = std::env::current_exe() else {
        return false;
    };
    let (dir, filename) = resolve_autostart_location();
    is_autostart_enabled_in(&binary, &dir, filename)
}

/// `is_autostart_enabled` helper with injectable dir/filename — used by tests.
fn is_autostart_enabled_in(_binary: &Path, dir: &Path, filename: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        let _ = filename;
        entry_exists(dir, LINUX_ENTRY_FILE)
    }

    #[cfg(target_os = "macos")]
    {
        let _ = filename;
        entry_exists(dir, MACOS_ENTRY_FILE)
    }

    #[cfg(windows)]
    {
        let _ = dir;
        let _ = filename;
        // Query the Run value via reg.exe; exit code 0 = enabled.
        let output = std::process::Command::new("reg.exe")
            .args(&["query", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE])
            .output();
        match output {
            Ok(o) => o.status.success(),
            Err(_) => false,
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = _binary;
        let _ = dir;
        let _ = filename;
        false
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // R10 test 1: linux_autostart_dir — XDG wins, HOME-only, neither.
    #[test]
    fn linux_autostart_dir_xdg_wins() {
        let p = linux_autostart_dir(Some("/custom/xdg"), Some("/home/user"));
        assert_eq!(p, PathBuf::from("/custom/xdg"));
    }

    #[test]
    fn linux_autostart_dir_xdg_blank_falls_to_home() {
        let p = linux_autostart_dir(Some("   "), Some("/home/user"));
        assert_eq!(p, PathBuf::from("/home/user/.config"));
    }

    #[test]
    fn linux_autostart_dir_home_only() {
        let p = linux_autostart_dir(None, Some("/home/user"));
        assert_eq!(p, PathBuf::from("/home/user/.config"));
    }

    #[test]
    fn linux_autostart_dir_neither() {
        let p = linux_autostart_dir(None, None);
        assert_eq!(p, PathBuf::from(".").join(".config"));
    }

    // R4 (Linux functional): the entry must live under `autostart/` — XDG desktop
    // environments only discover `.desktop` files there. Guards the R4/R5
    // reconciliation (linux_autostart_dir keeps the base dir; the entry dir adds
    // the subdir).
    #[test]
    fn linux_autostart_entry_dir_appends_autostart_subdir() {
        let p = linux_autostart_entry_dir(Some("/custom/xdg"), Some("/home/user"));
        assert_eq!(p, PathBuf::from("/custom/xdg").join("autostart"));

        let p = linux_autostart_entry_dir(None, Some("/home/user"));
        assert_eq!(p, PathBuf::from("/home/user/.config").join("autostart"));

        let p = linux_autostart_entry_dir(None, None);
        assert_eq!(p, PathBuf::from(".").join(".config").join("autostart"));
    }

    // R10 test 2: macos_launch_agents_dir.
    #[test]
    fn macos_launch_agents_dir_home() {
        let p = macos_launch_agents_dir(Some("/home/user"));
        assert_eq!(p, PathBuf::from("/home/user/Library/LaunchAgents"));
    }

    #[test]
    fn macos_launch_agents_dir_none() {
        let p = macos_launch_agents_dir(None);
        assert_eq!(p, PathBuf::from(".").join("Library").join("LaunchAgents"));
    }

    // R10 test 3: render_linux_desktop_entry.
    #[test]
    fn render_linux_desktop_entry_contains_binary() {
        let entry = render_linux_desktop_entry(Path::new("/opt/ponter/ponter-desktop"));
        assert!(entry.contains("/opt/ponter/ponter-desktop"));
        assert!(entry.contains("Type=Application"));
        assert!(entry.contains("X-GNOME-Autostart-enabled=true"));
        assert!(entry.contains("Terminal=false"));
    }

    #[test]
    fn render_linux_desktop_entry_quotes_spaced_path() {
        let entry = render_linux_desktop_entry(Path::new("/opt/ponter/ponter desktop"));
        // The Exec line must quote the binary path because it contains a space.
        let exec_line = entry.lines().find(|l| l.starts_with("Exec=")).unwrap();
        assert!(exec_line.contains("\"/opt/ponter/ponter desktop\""));
    }

    // R10 test 4: render_macos_plist.
    #[test]
    fn render_macos_plist_contains_binary_and_label() {
        let plist = render_macos_plist(Path::new("/opt/ponter/ponter-desktop"));
        assert!(plist.contains("/opt/ponter/ponter-desktop"));
        assert!(plist.contains("RunAtLoad"));
        assert!(plist.contains(MACOS_LABEL));
        assert!(plist.contains("ProgramArguments"));
    }

    // R10 test 5: windows_run_add_args / windows_run_delete_args.
    #[test]
    fn windows_run_add_args_exact() {
        let args = windows_run_add_args(Path::new("C:\\Program Files\\Ponter\\ponter.exe"));
        assert_eq!(args[0], "add");
        assert_eq!(args[1], WINDOWS_RUN_KEY);
        assert_eq!(args[3], WINDOWS_RUN_VALUE);
        assert_eq!(args[5], "REG_SZ");
        assert_eq!(args[7], "C:\\Program Files\\Ponter\\ponter.exe");
        assert_eq!(args[8], "/f");
    }

    #[test]
    fn windows_run_delete_args_exact() {
        let args = windows_run_delete_args();
        assert_eq!(args[0], "delete");
        assert_eq!(args[1], WINDOWS_RUN_KEY);
        assert_eq!(args[3], WINDOWS_RUN_VALUE);
        assert_eq!(args[4], "/f");
        assert_eq!(args.len(), 5);
    }

    // R10 test 6: file helpers round-trip in a temp dir.
    #[test]
    fn file_helpers_round_trip_in_temp_dir() {
        let dir =
            std::env::temp_dir().join(format!("ponter-autostart-test-{}", std::process::id()));

        // Clean up before (in case a prior run left debris).
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // remove_entry on a missing file is Ok.
        assert!(remove_entry(&dir, "missing.desktop").is_ok());
        // entry_exists is false for a missing file.
        assert!(!entry_exists(&dir, "missing.desktop"));

        // write + exists.
        write_entry(&dir, LINUX_ENTRY_FILE, "hello").unwrap();
        assert!(entry_exists(&dir, LINUX_ENTRY_FILE));

        // content is what we wrote.
        let content = std::fs::read_to_string(dir.join(LINUX_ENTRY_FILE)).unwrap();
        assert_eq!(content, "hello");

        // remove + exists false again.
        remove_entry(&dir, LINUX_ENTRY_FILE).unwrap();
        assert!(!entry_exists(&dir, LINUX_ENTRY_FILE));

        // Clean up.
        let _ = std::fs::remove_dir_all(&dir);
    }

    // R10 test 7 (M1 coverage): set_autostart_in round-trip in a temp dir.
    // This is the "uninstall round-trip" the brief's M1 targets: if
    // set_autostart_in(false) fails to remove the entry, this goes RED.
    #[test]
    fn set_autostart_in_round_trip_in_temp_dir() {
        let dir = std::env::temp_dir().join(format!("ponter-autostart-rt-{}", std::process::id()));

        // Clean up before.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let binary = Path::new("/opt/ponter/ponter-desktop");

        // Install.
        set_autostart_in(binary, &dir, LINUX_ENTRY_FILE, true).unwrap();
        assert!(is_autostart_enabled_in(binary, &dir, LINUX_ENTRY_FILE));

        // Uninstall — the entry must be gone.
        set_autostart_in(binary, &dir, LINUX_ENTRY_FILE, false).unwrap();
        assert!(!is_autostart_enabled_in(binary, &dir, LINUX_ENTRY_FILE));

        // Clean up.
        let _ = std::fs::remove_dir_all(&dir);
    }

    // R10 test 8 (M2 coverage): is_autostart_enabled_in returns false when
    // the entry is not present (not-present test).
    #[test]
    fn is_autostart_enabled_in_false_when_not_present() {
        let dir = std::env::temp_dir().join(format!("ponter-autostart-np-{}", std::process::id()));

        // Clean up before / ensure dir exists but no entry.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let binary = Path::new("/opt/ponter/ponter-desktop");
        assert!(!is_autostart_enabled_in(binary, &dir, LINUX_ENTRY_FILE));

        // Clean up.
        let _ = std::fs::remove_dir_all(&dir);
    }
}

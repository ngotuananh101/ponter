#!/usr/bin/env bash
set -euo pipefail
appdir="$(mktemp -d)/PonterDesktop.AppDir"
mkdir -p "$appdir/usr/bin" "$appdir/usr/share/applications" \
         "$appdir/usr/share/icons/hicolor/256x256/apps"
install -Dm755 target/release/ponter-desktop "$appdir/usr/bin/ponter-desktop"
install -Dm644 icons/128x128@2x.png \
  "$appdir/usr/share/icons/hicolor/256x256/apps/ponter-desktop.png"
cp icons/128x128@2x.png "$appdir/ponter-desktop.png"
cp icons/128x128@2x.png "$appdir/.DirIcon"
desktop_file="ponter-desktop.desktop"
if [ ! -f "$desktop_file" ]; then
  desktop_file="$(dirname "$0")/../ponter-desktop.desktop"
fi
cp "$desktop_file" "$appdir/ponter-desktop.desktop"
cp "$desktop_file" "$appdir/usr/share/applications/ponter-desktop.desktop"
cat > "$appdir/AppRun" <<'APPRUN'
#!/usr/bin/env bash
exec "$(dirname "$0")/usr/bin/ponter-desktop" "$@"
APPRUN
chmod +x "$appdir/AppRun"
mkdir -p target/release/bundle/appimage
ARCH="${ARCH:-x86_64}" appimagetool "$appdir" target/release/bundle/appimage/PonterDesktop-x86_64.AppImage

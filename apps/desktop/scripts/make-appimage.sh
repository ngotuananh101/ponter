#!/usr/bin/env bash
set -euo pipefail
appdir="$(mktemp -d)/PonterDesktop.AppDir"
mkdir -p "$appdir/usr/bin" "$appdir/usr/share/applications" \
         "$appdir/usr/share/icons/hicolor/256x256/apps"
install -Dm755 target/release/ponter-desktop "$appdir/usr/bin/ponter-desktop"
install -Dm644 icons/128x128@2x.png \
  "$appdir/usr/share/icons/hicolor/256x256/apps/ponter-desktop.png"
cat > "$appdir/ponter-desktop.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Ponter Desktop
Exec=ponter-desktop
Icon=ponter-desktop
Categories=Utility;Network;
DESKTOP
cp "$appdir/ponter-desktop.desktop" "$appdir/usr/share/applications/"
cat > "$appdir/AppRun" <<'APPRUN'
#!/usr/bin/env bash
exec "$(dirname "$0")/usr/bin/ponter-desktop" "$@"
APPRUN
chmod +x "$appdir/AppRun"
mkdir -p target/release/bundle/appimage
ARCH="${ARCH:-x86_64}" appimagetool "$appdir" target/release/bundle/appimage/PonterDesktop-x86_64.AppImage

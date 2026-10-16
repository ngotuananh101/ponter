#!/bin/bash
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}' || true
fi
rm -f '/usr/bin/${executable}'
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi
exit 0

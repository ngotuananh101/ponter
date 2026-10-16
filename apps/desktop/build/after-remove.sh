#!/bin/bash
# RPM passes the number of remaining package instances as $1: 0 means the
# last copy is being erased, while 1+ means an upgrade (the replacement is
# already installed). electron-builder supplies no before/after-upgrade
# hooks, so this script runs for every %postun: upgrades must exit before
# touching the shared alternative, the /usr/bin link, or the databases.
if [ "$1" != "0" ]; then
    exit 0
fi
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

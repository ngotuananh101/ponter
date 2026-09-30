#!/bin/sh
# Entrypoint for the @ponter/server container.
#
# Why this exists: the entrypoint drops to the unprivileged `node` user (UID
# 1000) before exec'ing the server, but `DATABASE_PATH` lives on a
# bind-mounted host directory (`./data:/app/data`). The bind mount replaces
# whatever ownership the image baked in with the host directory's own, so a
# `./data` that does not already belong to UID 1000 — a fresh clone, a
# root-owned `mkdir`, a rootless Podman UID mapping — makes SQLite fail with
# `SQLITE_CANTOPEN: unable to open database file` and the container exits.
#
# The fix is the standard one for this shape: start as root, take ownership of
# the data directory, then drop to `node` before exec'ing the server. The
# process that actually serves traffic is still unprivileged; only this
# pre-exec step runs as root, and only to `chown` one directory.
#
# `su-exec` (installed in the runner stage) performs the drop. BusyBox's
# `setpriv` is present in the base image but only handles capabilities — it has
# no `--reuid`/`--regid`, so it cannot switch user.
set -e

DATA_DIR="$(dirname "${DATABASE_PATH:-/app/data/remote.db}")"

# Only attempt the ownership fix when we are actually root: running this as
# `node` (e.g. `podman run --user node`) must not turn into a hard failure, it
# should just try and report the real SQLite error if the directory is
# genuinely unwritable.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi

exec "$@"

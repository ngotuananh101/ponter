#!/usr/bin/env bash
# Self-build the Ponter desktop app (ADR-61, Path B).
#
# Tauri v2 does not interpolate environment variables inside tauri.conf.json,
# so repointing the updater requires a build-time `--config` overlay. This
# script merges the overlay over the committed config and leaves the committed
# config untouched.
#
#   PONTER_UPDATE_ENDPOINT=https://github.com/<you>/<fork>/releases/latest/download/latest.json
#   PONTER_UPDATE_PUBKEY="$(cat ~/.tauri/my-updater.key.pub)"
#   bash apps/desktop/scripts/build-self.sh
#
# With neither variable set this is a plain `tauri build` (auto-update stays on
# the committed config). To disable auto-update entirely, remove the
# `plugins.updater` block from tauri.conf.json instead (Path A) — see
# docs/guides/self-hosting.md.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
desktop_dir="$repo_root/apps/desktop"

endpoint="${PONTER_UPDATE_ENDPOINT:-}"
pubkey="${PONTER_UPDATE_PUBKEY:-}"

if [[ -z "$endpoint" && -z "$pubkey" ]]; then
  echo "build-self: no PONTER_UPDATE_* set; running a plain tauri build" >&2
  cd "$desktop_dir"
  exec pnpm exec tauri build
fi

if [[ -z "$endpoint" || -z "$pubkey" ]]; then
  echo "build-self: set BOTH PONTER_UPDATE_ENDPOINT and PONTER_UPDATE_PUBKEY (or neither)" >&2
  exit 2
fi

# Build the overlay as JSON with the two strings escaped by node, so a pubkey
# containing slashes/newlines cannot break the JSON.
overlay="$(
  PONTER_UPDATE_ENDPOINT="$endpoint" PONTER_UPDATE_PUBKEY="$pubkey" node -e '
    const endpoint = process.env.PONTER_UPDATE_ENDPOINT;
    const pubkey = process.env.PONTER_UPDATE_PUBKEY;
    process.stdout.write(JSON.stringify({
      plugins: { updater: { endpoints: [endpoint], pubkey, requireSignedVersion: true } },
    }));
  '
)"

echo "build-self: applying updater overlay (endpoint=$endpoint)" >&2
cd "$desktop_dir"
exec pnpm exec tauri build --config "$overlay"

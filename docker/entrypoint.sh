#!/bin/sh
set -e

DATA_DIR="$(dirname "${DATABASE_PATH:-/app/data/remote.db}")"

# Fix database directory ownership if running as root
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
fi

# Render runtime frontend configuration
CONFIG_FILE="/usr/share/nginx/html/config.js"
mkdir -p "$(dirname "$CONFIG_FILE")"

cat <<EOF > "$CONFIG_FILE"
// Runtime configuration injected by container entrypoint
window.__PONTER_CONFIG__ = {
  apiUrl: "${PONTER_API_URL:-}"
};
EOF

exec "$@"

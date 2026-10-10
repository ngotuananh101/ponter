#!/usr/bin/env bash
set -euo pipefail

url="${1:-${DEPLOY_BE_WEBHOOK:-}}"
if [ -z "$url" ]; then
  echo "No webhook URL provided, skipping."
  exit 0
fi

echo "Triggering deployment webhook..."
# Deployment webhook with SSL verification disabled by default (-k / --insecure) per deployment requirements.
# Try POST first, fallback to GET if POST is not accepted (e.g. 405 Method Not Allowed).
if ! curl -k -fsS --max-time 30 -X POST "$url"; then
  echo "POST failed, retrying with GET..."
  curl -k -fsS --max-time 30 "$url"
fi
echo "Deployment webhook triggered successfully."

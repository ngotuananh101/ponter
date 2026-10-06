#!/usr/bin/env bash
#
# Pins the prune step's failure message. The prune step lives in a GitHub Actions
# `run:` body, so we extract that body from the workflow and run it against a
# stubbed `curl` that fails — proving a login failure prints an ::error:: line
# saying the image published OK (owner design point 4), not a bare curl error.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workflow="$here/../.github/workflows/docker-publish.yml"

body="$(awk '
  /^      - name: Prune old sha-\* tags/ {inblock=1}
  inblock && /^        run: \|/ {inrun=1; next}
  inrun {
    if ($0 ~ /^          /) { sub(/^          /,""); print; next }
    if ($0 ~ /^[[:space:]]*$/) { print ""; next }
    exit
  }
' "$workflow")"

if [[ -z "$body" ]]; then
  echo "FAIL: could not extract the prune step body from $workflow" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf '%s\n' "$body" > "$tmp/step.sh"

if ! bash -n "$tmp/step.sh"; then
  echo "FAIL: the extracted prune step body is not valid bash" >&2
  exit 1
fi

# Stub curl to fail like a bad-credentials 401.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl: (22) The requested URL returned error: 401" >&2
exit 22
STUB
chmod +x "$tmp/bin/curl"

set +e
out="$(PATH="$tmp/bin:$PATH" IMAGE_NAME="example/ponter" \
  DOCKERHUB_USERNAME="u" DOCKERHUB_TOKEN="t" bash "$tmp/step.sh" 2>&1)"
code=$?
set -e

if [[ "$code" -eq 0 ]]; then
  echo "FAIL: the prune step exited 0 on a login failure (expected non-zero)" >&2
  exit 1
fi
if ! grep -q "image published OK" <<<"$out"; then
  echo "FAIL: a login failure did not print 'image published OK':" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

echo "ok   prune step login failure says the image published OK"
echo "all prune-step message tests passed"

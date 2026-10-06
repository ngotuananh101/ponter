#!/usr/bin/env bash
#
# Fixture tests for docker/prune-tags.sh — the pure selection half of the
# publish workflow's prune step. No network: each fixture is the NDJSON the
# workflow feeds in, and each assertion is the exact tag list the script must
# print. Run: bash docker/prune-tags.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/prune-tags.sh"

fail=0
assert_eq() { # <name> <expected> <actual>
  if [[ "$2" != "$3" ]]; then
    printf 'FAIL %s\n  expected: %q\n  actual:   %q\n' "$1" "$2" "$3" >&2
    fail=1
  else
    printf 'ok   %s\n' "$1"
  fi
}

select_tags() { # <fixture-file> [extra args...] -> sorted, space-joined stdout
  local f="$1"; shift
  # `sort` makes the assertion order-independent: the script prints the prune
  # set newest-first, but the workflow DELETEs each tag regardless of order, so
  # the test asserts the SET, not an arbitrary print order.
  bash "$script" "$@" < "$f" 2>/dev/null | sort | paste -sd' ' -
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Case 1 — 5 sha + latest + a custom tag: keep the 3 newest sha, prune the 2 oldest.
cat > "$tmp/five.ndjson" <<'JSON'
{"name":"latest","last_updated":"2026-10-06T10:00:00Z"}
{"name":"sha-aaaaaaa","last_updated":"2026-10-01T10:00:00Z"}
{"name":"sha-bbbbbbb","last_updated":"2026-10-02T10:00:00Z"}
{"name":"sha-ccccccc","last_updated":"2026-10-03T10:00:00Z"}
{"name":"sha-ddddddd","last_updated":"2026-10-04T10:00:00Z"}
{"name":"sha-eeeeeee","last_updated":"2026-10-05T10:00:00Z"}
{"name":"v1.2.3","last_updated":"2026-10-06T09:00:00Z"}
JSON
assert_eq "keeps 3 newest sha, prunes the 2 oldest" \
  "sha-aaaaaaa sha-bbbbbbb" "$(select_tags "$tmp/five.ndjson")"

# Case 2 — exactly 3 sha tags: no-op.
cat > "$tmp/three.ndjson" <<'JSON'
{"name":"sha-aaaaaaa","last_updated":"2026-10-01T10:00:00Z"}
{"name":"sha-bbbbbbb","last_updated":"2026-10-02T10:00:00Z"}
{"name":"sha-ccccccc","last_updated":"2026-10-03T10:00:00Z"}
JSON
assert_eq "exactly 3 sha tags -> nothing to prune" "" "$(select_tags "$tmp/three.ndjson")"

# Case 3 — a tie on last_updated breaks by name ascending (deterministic).
# Four sha tags, keep 3: the newest (10-06) is kept, then the three 10-05 tags
# tie and are ordered by name ascending (aaaaaaa, bbbbbbb, zzzzzzz), so the
# LAST keep slot goes to bbbbbbb and zzzzzzz is the single tag pruned. A wrong
# tie-break direction (descending) would prune aaaaaaa instead — so this
# expectation discriminates the direction.
cat > "$tmp/tie.ndjson" <<'JSON'
{"name":"sha-zzzzzzz","last_updated":"2026-10-05T10:00:00Z"}
{"name":"sha-aaaaaaa","last_updated":"2026-10-05T10:00:00Z"}
{"name":"sha-mmmmmmm","last_updated":"2026-10-06T10:00:00Z"}
{"name":"sha-bbbbbbb","last_updated":"2026-10-05T10:00:00Z"}
JSON
assert_eq "tie broken by name ascending" "sha-zzzzzzz" "$(select_tags "$tmp/tie.ndjson")"

# Case 4 — non-sha names are never selected; malformed objects do not crash.
cat > "$tmp/mixed.ndjson" <<'JSON'
{"name":"latest","last_updated":"2026-10-06T10:00:00Z"}
{"name":"main","last_updated":"2026-10-06T10:00:00Z"}
{"name":"v2.0.0","last_updated":"2026-10-06T10:00:00Z"}
{"name":"sha-1111111","last_updated":null}
JSON
assert_eq "non-sha ignored, null timestamp tolerated" "" "$(select_tags "$tmp/mixed.ndjson")"

# Case 5 — custom --keep and --prefix.
cat > "$tmp/keep1.ndjson" <<'JSON'
{"name":"sha-aaaaaaa","last_updated":"2026-10-01T10:00:00Z"}
{"name":"sha-bbbbbbb","last_updated":"2026-10-02T10:00:00Z"}
JSON
assert_eq "--keep 1 prunes the older" "sha-aaaaaaa" "$(select_tags "$tmp/keep1.ndjson" --keep 1)"

# Case 6 — a flag with no value is a bad-argument error: exit 2, not a bash crash (exit 1).
if bash "$script" --keep </dev/null >/dev/null 2>&1; then code=0; else code=$?; fi
if [[ "$code" -eq 2 ]]; then
  printf 'ok   missing --keep value exits 2\n'
else
  printf 'FAIL missing --keep value exit=%s (want 2)\n' "$code" >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "FAILED" >&2
  exit 1
fi
echo "all prune-tags selection tests passed"

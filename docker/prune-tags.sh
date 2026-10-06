#!/usr/bin/env bash
#
# Select which image tags to prune, keeping the N most recent for a prefix.
#
# Pure, side-effect-free selection. Reads Docker Hub tag objects as
# newline-delimited JSON on stdin (the `results[]` entries of
# GET /v2/repositories/{ns}/{repo}/tags) and prints the tag names to DELETE,
# one per line, on stdout. Diagnostics go to stderr. Network I/O and the
# DELETE calls live in the workflow — this script is the part worth testing,
# so it is the part kept separate (the workflow and QA run this same file).
#
# Ordering: newest first by `last_updated`, with `name` ascending as a
# deterministic tie-break. Docker Hub returns ISO-8601 UTC timestamps, which
# sort lexically.
#
# Usage: prune-tags.sh [--keep N] [--prefix sha-] < tags.ndjson
set -euo pipefail

keep=3
prefix='sha-'
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      keep="${2:-}"
      if [[ -z "$keep" ]]; then echo "prune-tags: --keep needs a value" >&2; exit 2; fi
      shift 2 ;;
    --prefix)
      prefix="${2:-}"
      if [[ -z "$prefix" ]]; then echo "prune-tags: --prefix needs a value" >&2; exit 2; fi
      shift 2 ;;
    *) echo "prune-tags: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$keep" =~ ^[0-9]+$ ]]; then
  echo "prune-tags: invalid --keep value '$keep' (expected a non-negative integer)" >&2
  exit 2
fi

# Keep prefix matches, order newest-first (name asc on ties), then drop the
# first $keep and print the rest.
mapfile -t matched < <(
  jq -r --arg prefix "$prefix" \
    'select((.name // "") | startswith($prefix)) | [(.last_updated // ""), .name] | @tsv' \
  | sort -k1,1r -k2,2 \
  | cut -f2
)

total="${#matched[@]}"
if (( total <= keep )); then
  echo "prune-tags: ${total} '${prefix}' tag(s) present, keep=${keep} — nothing to prune" >&2
  exit 0
fi

kept=("${matched[@]:0:keep}")
pruned=("${matched[@]:keep}")
echo "prune-tags: keeping ${keep} of ${total} '${prefix}' tag(s): ${kept[*]}" >&2
echo "prune-tags: selecting ${#pruned[@]} for deletion: ${pruned[*]}" >&2
printf '%s\n' "${pruned[@]}"

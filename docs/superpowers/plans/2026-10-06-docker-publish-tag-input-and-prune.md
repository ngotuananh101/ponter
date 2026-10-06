# Docker Publish — optional tag input + sha-* prune (keep 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human trigger of the Docker Publish workflow attach one optional extra tag to the published manifest, and automatically prune old `sha-*` tags so only the three most recent survive.

**Architecture:** The workflow already builds per-platform images by digest and attaches the final tags in a `merge` job (`docker/metadata-action`). This plan (1) adds a `workflow_dispatch.inputs.tag` string and one `type=raw` metadata line, (2) adds a `validate` job that fails fast on an invalid or production-moving tag, and (3) adds a prune step after the manifest push that lists every Docker Hub tag page, selects the `sha-*` tags to delete, and DELETEs them via the Docker Hub API. The pure selection logic lives in a small, fixture-tested script so both the workflow and QA run the *same* code.

**Tech Stack:** GitHub Actions (workflow_dispatch, `docker/metadata-action@v6.2.0`), bash, `jq` (present on `ubuntu-latest`), Docker Hub v2 API (`/v2/users/login`, `/v2/repositories/{ns}/{repo}/tags`).

**Spec:** No standalone spec. The design authority is the owner decision relayed by PM on 2026-10-06 (six numbered design points + semantics ruling). This plan implements those points verbatim; every deviation is recorded as a `Ruling:` in the SDD ledger.

## Global Constraints

- **Strict-fail prune.** If the Docker Hub token lacks Delete scope the prune step must go red, but its message must say the image published fine and to check the PAT Delete scope — never imply the publish itself failed. (Owner ruling #4.)
- **Tag semantics.** With a `tag` input: still create `sha-*` as today, do NOT prune. Without a `tag` input: prune keep-3 on every ref, including feature branches. (Owner ruling #5.)
- **Tag input.** `workflow_dispatch.inputs.tag`: `type: string`, `required: false`, `default: ''`. Empty ⇒ `latest`/`sha` only (today's behavior).
- **Tag validation.** When a tag is supplied: regex `^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$`; reject `latest` when `github.ref != 'refs/heads/main'`. Fail early, clear message.
- **Prune selection.** Filter `name` starting with `sha-`; sort `last_updated` desc, `name` asc as tie-break; keep the first 3; DELETE the rest; ≤3 ⇒ no-op. List ALL pages by following `next` (never a fixed page count).
- **Docs language:** English (repo convention). Update `docker/README.md` and `docker/DOCKERHUB.md`.
- **Commits:** path-limited (`git commit -m "..." -- <paths>`), never `git add .`, never `git stash`. No push — wait for PM to seek owner approval.
- **Worktree:** isolated from `main` (`ci/docker-publish-tag-input`), never the shared WS3 checkout. Verify `git branch --show-current` before every commit (detached-HEAD gotcha).
- Do not touch `apps/web/src/components/ui/` (generated). Do not touch the WS3 branch.

## Review Focus

Input classes / failure modes the design implies but no task's tests exercise by default — each gets a test in its owning task:

1. **Exactly 3 or fewer `sha-*` tags present** ⇒ prune must be a clean no-op (no API DELETE), exit 0. (Task 1.)
2. **Ordering ties** — two tags with the same `last_updated` must break by `name` ascending so the result is deterministic. (Task 1.)
3. **Non-`sha-*` tags** (`latest`, a custom `v1.2.3`, a `main` branch tag) must never be selected for deletion. (Task 1.)
4. **Malformed / unexpected tag objects** (`last_updated` null, empty stream) must not crash the selection. (Task 1.)
5. **A `tag` input equal to `latest` from a non-`main` ref** must be rejected before any build (Task 2, validate job).
6. **Empty `tag` input** must (a) not fail the validate job and (b) still run prune (Task 2).

---

### Task 1: Prune selection script + fixture tests

**Files:**
- Create: `docker/prune-tags.sh`
- Create: `docker/prune-tags.test.sh`
- Test: `docker/prune-tags.test.sh`

**Interfaces:**
- Consumes: newline-delimited JSON tag objects (`{"name": "...", "last_updated": "..."}`), one per line, on stdin — the shape of each element of `GET /v2/repositories/{ns}/{repo}/tags` → `results[]`.
- Produces: `docker/prune-tags.sh [--keep N] [--prefix sha-]` → prints the tag names to DELETE (one per line) on **stdout**; human diagnostics on **stderr**; exit 0 on success, 2 on bad arguments. The workflow (Task 2) and QA both call this exact file.

- [ ] **Step 1: Write the failing test**

Create `docker/prune-tags.test.sh`:

```bash
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

if [[ "$fail" -ne 0 ]]; then
  echo "FAILED" >&2
  exit 1
fi
echo "all prune-tags selection tests passed"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash docker/prune-tags.test.sh`
Expected: FAIL — `prune-tags.sh` does not exist yet (`bash: docker/prune-tags.sh: No such file or directory`), so every `assert_eq` compares against empty/garbage output and at least one case fails.

- [ ] **Step 3: Write the minimal implementation**

Create `docker/prune-tags.sh`:

```bash
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
    --keep)   keep="${2:?--keep needs a value}"; shift 2 ;;
    --prefix) prefix="${2:?--prefix needs a value}"; shift 2 ;;
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash docker/prune-tags.test.sh`
Expected: PASS — five `ok` lines and `all prune-tags selection tests passed`.

- [ ] **Step 5: Make both scripts executable and commit**

```bash
chmod +x docker/prune-tags.sh docker/prune-tags.test.sh
git add docker/prune-tags.sh docker/prune-tags.test.sh
git commit -m "ci(docker): add a fixture-tested prune-selection script"
```

---

### Task 2: Workflow — tag input, validate job, prune step

**Files:**
- Modify: `.github/workflows/docker-publish.yml`
- Test: `docker/prune-tags.test.sh` (Task 1, re-run), `actionlint`

**Interfaces:**
- Consumes: `docker/prune-tags.sh` (Task 1) — `--keep 3`, NDJSON on stdin, tag names to delete on stdout.
- Produces: `workflow_dispatch.inputs.tag` (string); a `validate` job (fail-fast on bad/`latest`-from-non-main tag); one `type=raw,value=${{ inputs.tag }},enable=${{ inputs.tag != '' }}` metadata line; a `Prune old sha-* tags (keep 3 newest)` merge-job step gated on `if: ${{ inputs.tag == '' }}`.

- [ ] **Step 1: Add the `tag` input**

Change the trigger block (currently just `on:\n  workflow_dispatch:`) to:

```yaml
on:
  workflow_dispatch:
    inputs:
      tag:
        description: 'Optional extra tag to attach to the published manifest (e.g. v1.2.3); empty = latest/sha only'
        required: false
        default: ''
        type: string
```

- [ ] **Step 2: Add the validate job**

Insert a new job BEFORE `build` (and make `build` depend on it). Put the condition on the **step**, not the job — a job-level `if` would make a skipped `validate` skip `build` too, and an empty tag would then publish nothing:

```yaml
  validate:
    name: Validate tag input
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Validate tag input
        if: ${{ inputs.tag != '' }}
        shell: bash
        env:
          TAG_INPUT: ${{ inputs.tag }}
          REF_NAME: ${{ github.ref }}
        run: |
          set -euo pipefail
          if [[ ! "$TAG_INPUT" =~ ^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$ ]]; then
            echo "::error::invalid tag '${TAG_INPUT}' — must match ^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$"
            exit 1
          fi
          if [[ "$TAG_INPUT" == "latest" && "$REF_NAME" != "refs/heads/main" ]]; then
            echo "::error::refusing 'latest' from '${REF_NAME}' — only refs/heads/main may move the production tag"
            exit 1
          fi
          echo "Tag input '${TAG_INPUT}' is valid."
```

Add to the `build` job (first line after `build:`):

```yaml
    needs: validate
```

- [ ] **Step 3: Attach the custom tag in the merge job metadata**

In the `merge` job's `Docker metadata` step, add the extra `type=raw` line to `tags:` (between the `latest` line and the `sha` line):

```yaml
          tags: |
            type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}
            type=raw,value=${{ inputs.tag }},enable=${{ inputs.tag != '' }}
            type=sha,format=short
```

- [ ] **Step 4: Add the prune step**

Add a `Checkout code` step (`actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`) to the `merge` job so it can call `docker/prune-tags.sh`, then add this step AFTER `Create and push manifest list`:

```yaml
      - name: Prune old sha-* tags (keep 3 newest)
        if: ${{ inputs.tag == '' }}
        shell: bash
        env:
          DOCKERHUB_USERNAME: ${{ secrets.DOCKERHUB_USERNAME }}
          DOCKERHUB_TOKEN: ${{ secrets.DOCKERHUB_TOKEN }}
        run: |
          set -euo pipefail

          image="${IMAGE_NAME}"
          ns="${image%%/*}"
          repo="${image##*/}"

          # A fresh Hub API login: the registry token from docker/login-action
          # is scoped for pushes, not for the Hub API's tag management.
          payload="$(jq -nc --arg u "$DOCKERHUB_USERNAME" --arg p "$DOCKERHUB_TOKEN" '{username:$u,password:$p}')"
          token="$(curl -fsS -X POST https://hub.docker.com/v2/users/login \
            -H 'Content-Type: application/json' -d "$payload" | jq -r '.token')"
          if [[ -z "$token" || "$token" == "null" ]]; then
            echo "::error::Docker Hub API login failed — check DOCKERHUB_USERNAME / DOCKERHUB_TOKEN"
            exit 1
          fi

          # Walk every page (the API paginates via `next`).
          all="$(mktemp)"
          page="https://hub.docker.com/v2/repositories/${ns}/${repo}/tags?page_size=100"
          while [[ -n "$page" && "$page" != "null" ]]; do
            body="$(curl -fsS -H "Authorization: Bearer ${token}" "$page")"
            jq -c '.results[]' <<<"$body" >> "$all"
            page="$(jq -r '.next // empty' <<<"$body")"
          done

          selected="$(mktemp)"
          bash docker/prune-tags.sh --keep 3 < "$all" > "$selected"
          mapfile -t to_delete < "$selected"
          rm -f "$all" "$selected"

          if [[ "${#to_delete[@]}" -eq 0 ]]; then
            echo "::notice::No sha-* tags to prune (3 or fewer present)."
            exit 0
          fi

          for tag in "${to_delete[@]}"; do
            echo "Deleting ${image}:${tag}"
            if ! curl -fsS -X DELETE \
              -H "Authorization: Bearer ${token}" \
              "https://hub.docker.com/v2/repositories/${ns}/${repo}/tags/${tag}/"; then
              echo "::error::image published OK, but pruning '${tag}' failed — check the DOCKERHUB_TOKEN Delete scope"
              exit 1
            fi
          done
          echo "::notice::Pruned ${#to_delete[@]} old sha-* tag(s): ${to_delete[*]}"
```

- [ ] **Step 5: Validate the workflow and the selection wiring**

Run: `/tmp/actionlint .github/workflows/docker-publish.yml`
Expected: no output, exit 0 (actionlint parses the YAML and all `${{ }}` expressions).

Run: `bash docker/prune-tags.test.sh`
Expected: PASS (Task 1's script is unchanged and still the selection the step calls).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/docker-publish.yml
git commit -m "ci(docker): add an optional tag input and sha-* prune (keep 3)"
```

---

### Task 3: Docs — README + Docker Hub page

**Files:**
- Modify: `docker/README.md`
- Modify: `docker/DOCKERHUB.md`
- Test: `prettier --check` (from the shared checkout's `node_modules`)

**Interfaces:**
- Consumes: the workflow's new input + prune semantics (Task 2).
- Produces: user-facing docs matching the shipped behavior. No code.

- [ ] **Step 1: Update `docker/README.md`**

In the "Deploying a new version" section, extend the tags table (currently "Two tags are produced") with the optional custom tag row, and add a sentence about the 3-tag `sha-` retention window. In step 1, add the optional `tag` input to the publish instructions. Rewrite the **Rolling back** paragraph to state the 3-sha horizon. Update the **Repository secrets** paragraph to require the token's **Delete** scope. Concretely:

- Tags table becomes three rows — `:latest` (main only), `:sha-<sha>` (every run; only the 3 most recent are kept), and an optional custom tag from the `tag` input (persists).
- Step 1 gains: "Optionally, set the **tag** input to also attach a named tag (e.g. `v1.2.3`) to the published manifest; leaving it empty keeps `latest`/`sha` only."
- Rolling back: "…pin the previous `sha-` tag… **Only the three most recent `sha-` tags are retained** — each tag-less publish prunes older ones, so pin a `sha-` tag only within that window, or pass an explicit `tag` input for a durable name."
- Secrets: "…an access token with Read/Write **and Delete** — the publish workflow prunes old `sha-` tags through the Docker Hub API, so a token without Delete scope fails the prune step (the image is still published)."

- [ ] **Step 2: Update `docker/DOCKERHUB.md`**

In the "Tags" section, add the custom-tag row and a prune note:

- Table gains a row for the optional custom tag (passed as the `tag` input; persists).
- Add after the table: "Only the three most recent `sha-<short>` tags are retained; each publish without a custom tag prunes older `sha-` tags automatically. Pin a `sha-` tag only within that window, or use a custom tag for a durable name."

- [ ] **Step 3: Format-check the docs**

Run (prettier from the shared checkout to avoid a worktree `pnpm install`):
`node /mnt/Data/Ponta/remote-platform/node_modules/.bin/prettier --check docker/README.md docker/DOCKERHUB.md`
Expected: "All matched files use Prettier code style!"

- [ ] **Step 4: Commit**

```bash
git add docker/README.md docker/DOCKERHUB.md
git commit -m "docs(docker): document the tag input and sha-* retention window"
```

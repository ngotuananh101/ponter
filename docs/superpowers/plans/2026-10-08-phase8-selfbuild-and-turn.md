# Phase 8: Open-Source Self-Build Enablement + Provider-Selectable TURN — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a third party clone, build, and self-host Ponter from source (with the author's identity preserved and every author-specific default documented as overridable), and let an operator select `coturn | cloudflare | none` as the TURN provider without changing existing deployments.

**Architecture:** Two independent workstreams. **8a** is documentation plus one optional build helper script and the standard community files — no product code, no CI change. **8b** is a single server module (`apps/server/src/utils/ice.ts`) that becomes `async`, dispatches on `TURN_PROVIDER`, and normalizes every provider's output into the existing shared ICE shape; its two call sites are already `async`. Nothing in the wire protocol, the E2EE model, the agent's Rust parsing, or the desktop build's official defaults changes.

**Tech Stack:** TypeScript (Node.js 24, Hono), Vitest (server tests in `apps/server/test/**`), Rust (agent, `cargo test`), Tauri v2 (`tauri build --config`), Docker Compose, Markdown docs.

**Spec:** `docs/superpowers/specs/2026-10-08-phase8-selfbuild-and-turn-design.md` (ADR-59..63) — the plan argues from the spec; read both.

## Global Constraints

- **Runtime floors:** Node.js `>= 24` (global `fetch` is used, no HTTP client added), pnpm `>= 12`, Rust stable. Copied from `package.json` `engines`.
- **No new dependency for 8b beyond global `fetch`** (Node 24). No new npm package, no new crate.
- **The shared ICE shape is frozen.** `IceServerConfig` (`packages/shared/src/types/webrtc.ts`) and the Rust `IceServerEntry` (`apps/agent/src/signal.rs`) are **unchanged**. Every `urls` value emitted by the server must be a **string array** (the agent parses `urls: Vec<String>`).
- **`TURN_PROVIDER` default is `coturn`; existing deployments are byte-for-byte unchanged.** An unset/empty `TURN_PROVIDER` resolves to `coturn` and reproduces the pre-Phase-8 output exactly.
- **Author branding is preserved (ADR-60).** Badges, repo links, the Docker Hub image name, and the desktop updater `pubkey`/`endpoints` stay the author's. Self-build support is **additive**: documented override or disable, never removal.
- **No protocol, security-model, E2EE, or UI change.** `packages/ui-components/src/components/ui/**` is generated — **never hand-modify it**; Phase 8 touches no UI.
- **Test integrity (binding):** no existing test is deleted, skipped, or weakened. Every change to an existing test is declared before→after with reason. New tests are additive. Report `it()`/`expect()` counts before→after for any touched test file.
- **Language:** technical artifacts (code, identifiers, shell, commits, repo docs) are **English**. Conversation replies are Vietnamese.

## Review Focus

The five input classes / failure modes the spec implies but no task's happy-path tests exercise — each is pinned by a test in the owning task:

1. **`TURN_PROVIDER` set to an unrecognized value** (a typo in `.env`, e.g. `TURN_PROVIDER=coturn-`). A reasonable operator expects the server to keep serving ICE rather than fail every connection — behavior: warn and fall back to `coturn`. Pinned in **Task 5**.
2. **`TURN_PROVIDER=none` with `STUN_URL` set.** The spec (ADR-62) says `none` is "public Google STUN, **or `STUN_URL` when set**", while today's no-TURN fallback ignores `STUN_URL`. Behavior: `none` honors `STUN_URL`. Pinned in **Task 5**.
3. **Cloudflare returns HTTP 200 with a malformed or empty body** (no `iceServers`). A reasonable operator expects no crash and no empty ICE list — behavior: fail-soft to STUN-only. Pinned in **Task 6**.
4. **The Cloudflare request throws** (DNS failure, connection reset). A reasonable operator expects the connection to still open — behavior: fail-soft to STUN-only, never an unhandled rejection at either call site. Pinned in **Task 6**.
5. **The agent receives a Cloudflare `turns:` (TLS) URL.** `is_unusable_turn_tcp` drops only `turn:` + `transport=tcp`; a `turns:` URL must survive the mapping or the agent silently loses its only UDP-blocked-network transport. Pinned in **Task 6** (Rust fixture test).

---

## File Structure

**8a — Self-build / self-host enablement (docs + one script + community files):**

| File | Responsibility |
|---|---|
| `docs/guides/development.md` (modify) | New "Build release artifacts from source" section for all four apps. |
| `docs/guides/self-hosting.md` (create) | Fork & self-host guide: updater disable-vs-override, Docker image, server URL. |
| `docs/guides/deployment.md` (modify) | "Build & publish your own image" path + TURN-provider reference. |
| `docker/README.md` (modify) | Self-publish path + `TURN_PROVIDER` env rows. |
| `apps/desktop/scripts/build-self.sh` (create) | Env-driven `tauri build --config` overlay helper (no-op when vars unset). |
| `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` (create) | Community hygiene files (project-specific, English). |
| `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`, `.github/PULL_REQUEST_TEMPLATE.md` (create) | Issue/PR templates. |
| `README.md` (modify) | Short "Self-hosting & building from source" pointer (no badge/link changes). |

**8b — Provider-selectable TURN (server code):**

| File | Responsibility |
|---|---|
| `apps/server/src/utils/ice.ts` (modify) | `buildIceServers` → `async`; `resolveTurnProvider`; `coturn`/`none`/`cloudflare` branches; array normalization; Cloudflare TTL cache. |
| `apps/server/src/routes/webrtc.ts` (modify) | `await buildIceServers(user.id)`. |
| `apps/server/src/routes/ws.ts` (modify) | `await buildIceServers(userId)`. |
| `apps/server/test/ice-provider.test.ts` (create) | Unit tests for dispatch, coturn regression, `none`, unknown-value fallback, Cloudflare success/cache/fail-soft. |
| `apps/agent/src/rtc.rs` (modify — test module only) | Fixture test pinning that a `turns:` URL survives `ice_servers_from_entries`. |
| `docker/.env.example`, `docker/docker-compose.prod.yml`, `docker/docker-compose.nginx.yml` (modify) | Document + wire `TURN_PROVIDER`, `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`. |

**Docs reconciliation:** `docs/ARCHITECTURE.md` (§8 Phase 8), `docs/README.md` (index).

## Execution & PR strategy

The spec ships two workstreams as **two pull requests** (ADR-59). Map the tasks to them:

- **PR 8a — Tasks 1, 2, 3, 4** (docs + one helper script + community files; no product code). Tasks 2 and 3 are coupled (the guide references the script), so they share a PR. Under the owner's docs policy, 8a may also land via the docs fast-path (direct to `main`) — the PM decides.
- **PR 8b — Tasks 5, 6, 7** (server code + agent test + env/docs). Tasks 5 and 6 modify the same module and the same test file; they are **one** reviewable unit and must not be split across PRs. Task 7 is the operator-facing config/docs for 8b.
- **Task 8** lands after both merge (it records the merged SHAs) via the docs fast-path.

Branch names: `phase8/selfbuild-enablement` (8a), `phase8/turn-provider` (8b).

---

## Task 1: Build-from-source guide (all four apps)

**Files:**
- Modify: `docs/guides/development.md` (append a new top-level section; the file currently ends at "## 6. Debugging Tips")
- Modify: `README.md` (add one pointer line in the Quick Start area)
- Modify: `docs/README.md` (index entry)

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: the canonical build commands the self-host guide (Task 2) and the README pointer link to.

- [ ] **Step 1: Confirm the real build commands from the tree**

Run these and record the exact output shape (they are the source of truth for the doc):

```bash
cd /mnt/Data/Ponta/remote-platform
node -e "console.log(require('./package.json').engines)"
node -e "console.log(require('./apps/server/package.json').scripts.build)"
node -e "console.log(require('./apps/web/package.json').scripts.build)"
node -e "console.log(require('./apps/agent/package.json').scripts.build)"
node -e "console.log(require('./apps/desktop/package.json').scripts.build)"
```

Expected: server `tsc` → `apps/server/dist/`; web `vue-tsc --noEmit && vite build` → `apps/web/dist/`; agent `cargo build --locked` → `apps/agent/target/debug/ponter-agent`; desktop `vue-tsc --noEmit && vite build` (then `pnpm tauri build` for the bundle).

- [ ] **Step 2: Append the build-from-source section to `docs/guides/development.md`**

Add, after the last existing section, a new section (English prose, matching the file's existing bilingual style where the file already mixes Vietnamese headings with English commands — keep commands verbatim):

````markdown
## 7. Building Release Artifacts from Source

This section builds a production artifact for each of the four apps. It assumes
the prerequisites from §1 (Node.js 24, pnpm 12, Rust stable). For Docker images,
see `docker/README.md`; for a fork that repoints the desktop updater, see
`docs/guides/self-hosting.md`.

### 7.1 Server (`apps/server`)

```bash
pnpm install --frozen-lockfile
pnpm --filter @ponter/server build
```

Output: `apps/server/dist/` (compiled JavaScript). Run it with:

```bash
node apps/server/dist/index.js
```

Required environment: `JWT_SECRET`, `REFRESH_TOKEN_SECRET` (each ≥ 32 chars).
`DATABASE_PATH` defaults to `./data/remote.db`.

### 7.2 Web (`apps/web`)

```bash
pnpm --filter @ponter/web build
```

Output: `apps/web/dist/` (static assets). Set `VITE_API_URL` (and, if you use
WebSocket signaling, `VITE_BROWSER_WS_SIGNALING=true`) **before** the build —
they are compiled in. Serve `dist/` from any static host.

### 7.3 Agent (`apps/agent`)

```bash
cargo build --release --manifest-path apps/agent/Cargo.toml
```

Output: `apps/agent/target/release/ponter-agent`. See
`docs/guides/agent-setup.md` for CLI options and systemd setup.

### 7.4 Desktop (`apps/desktop`)

The desktop app is Tauri v2. A self-built copy inherits the author's updater
key/endpoint from `apps/desktop/src-tauri/tauri.conf.json` unless you change it —
read `docs/guides/self-hosting.md` first.

```bash
pnpm --filter @ponter/desktop build          # frontend assets -> apps/desktop/dist
pnpm --filter @ponter/desktop tauri build    # native bundle
```

Output: installers under `apps/desktop/src-tauri/target/release/bundle/`
(`.deb` + `.AppImage` on Linux, `.dmg` on macOS, `.msi` + `.exe` on Windows).
Building a signed auto-update bundle requires your own signing key; building
without one is supported (auto-update simply stays inert). `pnpm tauri build`
needs the platform's Tauri prerequisites (system webkit/gtk packages on Linux).
````

- [ ] **Step 3: Add the README pointer**

In `README.md`, in the "⚡ Quick Start (Local Development)" area, add a single line after the section heading (do **not** touch badges, links, or the image name):

```markdown
> Building from source, self-hosting your own instance, or forking the desktop
> app? See [`docs/guides/development.md`](docs/guides/development.md) (build all
> four apps) and [`docs/guides/self-hosting.md`](docs/guides/self-hosting.md).
```

- [ ] **Step 4: Add the docs index entry**

In `docs/README.md`, under "### 2. Operational & Developer Guides", add:

```markdown
- **[Self-Hosting & Fork Guide](guides/self-hosting.md)**: Fork the repo, repoint or disable the desktop updater, and build/publish your own Docker image.
```

- [ ] **Step 5: Verify formatting and links**

```bash
pnpm exec prettier --check README.md docs/README.md
ls docs/guides/self-hosting.md   # Task 2 creates it; until then this is expected to fail
```

Expected: prettier reports the two root/index files clean (`docs/**` is in `.prettierignore`, so the guides are not prettier-checked). The `ls` is a forward reference satisfied by Task 2.

- [ ] **Step 6: Commit**

```bash
git add docs/guides/development.md README.md docs/README.md
git commit -m "docs(guides): build release artifacts from source for all four apps"
```

---

## Task 2: Fork & self-host guide + Docker self-publish path

**Files:**
- Create: `docs/guides/self-hosting.md`
- Modify: `docs/guides/deployment.md` (add the self-publish path under §3.1)
- Modify: `docker/README.md` (add the self-publish path under "Deploying a new version")

**Interfaces:**
- Consumes: the build commands from Task 1; the exact `plugins.updater` block and `docker/.env.example` variable names.
- Produces: the documented disable/override procedure (ADR-61) that Task 3's script implements.

- [ ] **Step 1: Confirm the author-specific defaults to document**

```bash
cd /mnt/Data/Ponta/remote-platform
grep -n '"pubkey"\|"endpoints"\|requireSignedVersion' apps/desktop/src-tauri/tauri.conf.json
grep -n 'DOCKERHUB_IMAGE' docker/.env.example
grep -n 'DOCKERHUB_IMAGE\|namespace' docker/README.md
```

Expected: the updater `pubkey` + `endpoints` (author's), `DOCKERHUB_IMAGE=ngotuananh2101/ponter`, and the README's note that the Docker Hub namespace comes from the `DOCKERHUB_USERNAME` secret.

- [ ] **Step 2: Create `docs/guides/self-hosting.md`**

```markdown
# Self-Hosting & Fork Guide

Ponter is MIT-licensed. You can fork it, build it from source, and run your own
instance. This guide covers the three author-specific defaults a fork has to
decide about. Building the four apps is covered in
[`development.md` §7](development.md#7-building-release-artifacts-from-source).

> **The official repo's identity stays as-is.** Badges, links, the published
> Docker Hub image, and the desktop updater key belong to the upstream author.
> A fork overrides them in its own copy; upstream does not remove them.

## 1. Desktop auto-update (ADR-61)

A self-built desktop app inherits the upstream updater `pubkey` and `endpoints`
compiled into `apps/desktop/src-tauri/tauri.conf.json`. That means an
unmodified self-build would poll the **upstream** release channel and reject
any binary not signed by the upstream key. Pick one of two paths.

### Path A — disable auto-update (recommended, no signing key)

Edit your fork's `apps/desktop/src-tauri/tauri.conf.json` and **remove the
`plugins.updater` block** (or set it to an empty object):

```jsonc
"plugins": {
  // "updater": { "pubkey": "...", "endpoints": ["..."], "requireSignedVersion": true }
}
```

Build normally (`pnpm --filter @ponter/desktop tauri build`). No signing key is
required and the app never checks for updates.

### Path B — repoint to your own update channel (optional)

If you publish your own signed releases, point the app at your manifest and
public key. Tauri v2 does **not** interpolate environment variables inside
`tauri.conf.json`, so use a build-time config overlay — `apps/desktop/scripts/build-self.sh`
does this for you:

```bash
export PONTER_UPDATE_ENDPOINT="https://github.com/<you>/<fork>/releases/latest/download/latest.json"
export PONTER_UPDATE_PUBKEY="$(cat ~/.tauri/my-updater.key.pub)"
bash apps/desktop/scripts/build-self.sh
```

The script merges the overlay over the committed config; the committed
`tauri.conf.json` is untouched. You are responsible for signing your own
release artifacts with your own key.

## 2. Docker image (self-publish)

The shipped Compose files pull the upstream image
(`ngotuananh2101/ponter`) via `DOCKERHUB_IMAGE`. To run your own:

```bash
docker build -f docker/Dockerfile.server -t <your-namespace>/ponter:dev .
```

Then, in `docker/.env`, set `DOCKERHUB_IMAGE=<your-namespace>/ponter:dev` and
`docker compose -f docker-compose.prod.yml up -d`. To publish a registry image
yourself, tag and push it:

```bash
docker tag <your-namespace>/ponter:dev <your-namespace>/ponter:latest
docker push <your-namespace>/ponter:latest
```

Upstream's `.github/workflows/docker-publish.yml` is wired to the upstream
Docker Hub secrets; a fork either adds its own secrets or pushes manually.

## 3. Server / API URL

The web client compiles its API URL at build time. Set `VITE_API_URL` (and
`VITE_BROWSER_WS_SIGNALING=true` if you use WebSocket signaling) before
`pnpm --filter @ponter/web build`, and set `CORS_ORIGIN` on the server to the
exact origin that serves the built web app.
```

- [ ] **Step 3: Add the self-publish path to `docs/guides/deployment.md`**

Under "## 3.1 Deploy phiên bản mới", after the existing step that points Compose at an image, add a subsection (English prose is fine; the surrounding file mixes Vietnamese — keep the new text clear and consistent with the existing step wording):

```markdown
### 3.1.1 Publish your own image (fork)

The shipped `DOCKERHUB_IMAGE` points at the upstream image. To deploy an image
you built yourself:

```bash
docker build -f docker/Dockerfile.server -t <your-namespace>/ponter:latest .
docker push <your-namespace>/ponter:latest
# then set DOCKERHUB_IMAGE=<your-namespace>/ponter:latest in docker/.env
```

See `docs/guides/self-hosting.md` §2 for the full fork walkthrough.
```

- [ ] **Step 4: Add the same pointer to `docker/README.md`**

In the "## Deploying a new version" section, after the `DOCKERHUB_IMAGE` override paragraph, add:

```markdown
To publish your **own** image instead of pulling the upstream one, see
[`docs/guides/self-hosting.md` §2](../docs/guides/self-hosting.md#2-docker-image-self-publish).
```

- [ ] **Step 5: Verify links resolve**

```bash
cd /mnt/Data/Ponta/remote-platform
test -f docs/guides/self-hosting.md && echo "self-hosting.md present"
grep -q 'self-hosting.md' docs/README.md README.md docker/README.md docs/guides/deployment.md && echo "all pointers present"
```

Expected: both lines print.

- [ ] **Step 6: Commit**

```bash
git add docs/guides/self-hosting.md docs/guides/deployment.md docker/README.md
git commit -m "docs(guides): fork & self-host guide with updater + docker self-publish paths"
```

---

## Task 3: Desktop self-build helper script

**Files:**
- Create: `apps/desktop/scripts/build-self.sh`
- Modify: `docs/guides/self-hosting.md` (already references the script in Task 2 §1 Path B — this task makes that reference real)

**Interfaces:**
- Consumes: `PONTER_UPDATE_ENDPOINT`, `PONTER_UPDATE_PUBKEY` env vars (ADR-61 Path B).
- Produces: a runnable `bash apps/desktop/scripts/build-self.sh` that is a passthrough when the vars are unset.

- [ ] **Step 1: Create the script**

```bash
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
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x apps/desktop/scripts/build-self.sh
```

- [ ] **Step 3: Verify the passthrough and the overlay paths (no real Tauri build)**

The passthrough branch must not require a full Tauri build to be observable. Verify the script's own logic by stubbing `pnpm` on `PATH`:

```bash
cd /mnt/Data/Ponta/remote-platform
tmpdir="$(mktemp -d)"
printf '#!/usr/bin/env bash\necho "STUB pnpm: $*"\n' > "$tmpdir/pnpm"
chmod +x "$tmpdir/pnpm"

echo "--- passthrough (no env) ---"
PATH="$tmpdir:$PATH" bash apps/desktop/scripts/build-self.sh
echo "--- overlay (both env) ---"
PATH="$tmpdir:$PATH" PONTER_UPDATE_ENDPOINT="https://example.com/latest.json" PONTER_UPDATE_PUBKEY="RWTESTKEY" bash apps/desktop/scripts/build-self.sh
echo "--- half-set (must exit 2) ---"
PATH="$tmpdir:$PATH" PONTER_UPDATE_ENDPOINT="https://example.com/latest.json" bash apps/desktop/scripts/build-self.sh; echo "exit=$?"
rm -rf "$tmpdir"
```

Expected:
- passthrough → `STUB pnpm: exec tauri build` and a "no PONTER_UPDATE_* set" notice.
- overlay → `STUB pnpm: exec tauri build --config {"plugins":{"updater":{"endpoints":["https://example.com/latest.json"],"pubkey":"RWTESTKEY","requireSignedVersion":true}}}`.
- half-set → error message and `exit=2`.

- [ ] **Step 4: Shellcheck (if available)**

```bash
command -v shellcheck >/dev/null && shellcheck apps/desktop/scripts/build-self.sh || echo "shellcheck not installed; skipped"
```

Expected: no findings, or a clear "not installed" notice.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/scripts/build-self.sh
git commit -m "feat(desktop): add build-self.sh updater-overlay helper (ADR-61)"
```

---

## Task 4: Community files

**Files:**
- Create: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`

**Interfaces:**
- Consumes: the real repo facts (monorepo layout, `pnpm` commands, CI workflows, MIT license).
- Produces: standard community hygiene files. No code, no CI change.

- [ ] **Step 1: Gather the facts the files must be accurate about**

```bash
cd /mnt/Data/Ponta/remote-platform
ls -1 .github/workflows/
grep -n '"packageManager"\|"engines"' package.json
head -1 README.md
ls -1 LICENSE 2>/dev/null || echo "no LICENSE file at root"
```

Expected: the workflow list (`ci-node.yml`, `ci-e2e.yml`, `build-agent.yml`, `build-desktop.yml`, `ci-docker.yml`, `docker-publish.yml`, `deploy.yml`), `pnpm@12.6.0`, Node `>=24`.

- [ ] **Step 2: Create `CONTRIBUTING.md`**

```markdown
# Contributing to Ponter

Thanks for your interest. Ponter is MIT-licensed; contributions are welcome.

## Development setup

See [`docs/guides/development.md`](docs/guides/development.md) for the full
setup (Node.js ≥ 24, pnpm ≥ 12, Rust stable).

## Before you open a pull request

Run the same gates CI runs:

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run lint --filter='!@ponter/agent'
pnpm exec turbo run typecheck --filter='!@ponter/agent'
pnpm format:check
pnpm exec turbo run test --filter='!@ponter/agent'
```

For the Rust agent:

```bash
cargo fmt --manifest-path apps/agent/Cargo.toml --check
cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/agent/Cargo.toml
```

## Guidelines

- Keep changes focused; one concern per pull request.
- **Never delete, skip, or weaken a test to make a suite pass.** If a test must
  change, keep its behavioral assertion and say in the PR why.
- Match the existing code style; `pnpm format` and `cargo fmt` fix most of it.
- Use English for code, comments, commit messages, and repo docs.
- Do not hand-edit generated shadcn-vue components under
  `packages/ui-components/src/components/ui/**`; wrap them instead.

## Commit messages

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:`,
`chore:`), imperative mood, scoped where useful (e.g. `fix(server): ...`).

## Reporting security issues

Do **not** open a public issue. See [`SECURITY.md`](SECURITY.md).
```

- [ ] **Step 3: Create `SECURITY.md`**

```markdown
# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public
issue. Use GitHub's "Report a vulnerability" (Security → Advisories) on the
upstream repository, or contact the maintainer listed on the repository profile.

Include: affected component, a description, reproduction steps, and impact.
You will get an acknowledgement as soon as possible and credit in the advisory
unless you ask to stay anonymous.

## Scope

Ponter is a zero-trust remote-access platform. Areas of particular interest:

- Authentication, token issuance/revocation, and the WebSocket ticket flow.
- The E2EE session-negotiation and peer-identity (Ed25519) verification paths.
- Input-injection gates and the sandboxed file-transfer root.
- TURN/ICE credential minting and the signaling relay.

## Supported versions

Only the latest `main` is supported. There are no maintained release branches.
```

- [ ] **Step 4: Create `CODE_OF_CONDUCT.md`**

```markdown
# Code of Conduct

## Our pledge

We want participation in Ponter to be a harassment-free experience for
everyone, regardless of age, body size, disability, ethnicity, gender identity
or expression, level of experience, nationality, personal appearance, race,
religion, or sexual identity and orientation.

## Expected behavior

- Be respectful of differing viewpoints and experiences.
- Give and accept constructive feedback gracefully.
- Focus on what is best for the project and its users.

## Unacceptable behavior

- Harassment, insults, or discriminatory comments.
- Publishing others' private information without permission.
- Sustained disruption of discussions or reviews.

## Enforcement

Maintainers may remove, edit, or reject comments, commits, and contributions
that violate this code, and may temporarily or permanently ban any contributor
for behavior they deem inappropriate. Report issues privately to the
maintainers via the repository profile.

## Attribution

This code of conduct is adapted from the
[Contributor Covenant](https://www.contributor-covenant.org), version 2.1.
```

- [ ] **Step 5: Create `.github/ISSUE_TEMPLATE/bug_report.md`**

```markdown
---
name: Bug report
about: Report a reproducible problem
title: ''
labels: bug
assignees: ''
---

**Describe the bug**
A clear description of what went wrong.

**To reproduce**
Steps, exact commands, and the inputs used.

**Expected behavior**
What you expected to happen.

**Environment**
- OS and version:
- Component (server / web / agent / desktop):
- Node.js version (`node -v`):
- pnpm version (`pnpm -v`):
- Rust version (`cargo -V`), if the agent/desktop is involved:
- Deployment (local dev / Docker / other):

**Logs**
Paste relevant output. Redact secrets, tokens, and public keys.
```

- [ ] **Step 6: Create `.github/ISSUE_TEMPLATE/feature_request.md`**

```markdown
---
name: Feature request
about: Suggest an idea or enhancement
title: ''
labels: enhancement
assignees: ''
---

**Problem**
What are you trying to do that is hard or impossible today?

**Proposed solution**
What you would like to happen.

**Alternatives**
Any workarounds or other approaches you considered.

**Scope**
Which component does this touch (server / web / agent / desktop / docs)?
```

- [ ] **Step 7: Create `.github/PULL_REQUEST_TEMPLATE.md`**

```markdown
## Summary

What this change does and why.

## Component(s)

- [ ] `apps/server`
- [ ] `apps/web`
- [ ] `apps/agent`
- [ ] `apps/desktop`
- [ ] `packages/*`
- [ ] `docs` / CI

## Testing

How you verified it. Include the commands you ran.

## Test-integrity checklist

- [ ] No test was deleted, skipped, or weakened.
- [ ] Any change to an existing test keeps its behavioral assertion and is
      explained above.
- [ ] If test files changed, `it()` / `expect()` counts are given before → after.

## Checklist

- [ ] `pnpm format:check` passes
- [ ] lint, typecheck, and tests pass for the affected workspace(s)
- [ ] Docs updated if behavior or setup changed
- [ ] No generated `ui/**` file was hand-edited
```

- [ ] **Step 8: Verify formatting**

```bash
cd /mnt/Data/Ponta/remote-platform
pnpm exec prettier --check CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md \
  .github/ISSUE_TEMPLATE/bug_report.md .github/ISSUE_TEMPLATE/feature_request.md \
  .github/PULL_REQUEST_TEMPLATE.md
```

Expected: all files pass. If prettier reformats a file, run `pnpm exec prettier --write <file>` and re-check.

- [ ] **Step 9: Commit**

```bash
git add CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md \
  .github/ISSUE_TEMPLATE/bug_report.md .github/ISSUE_TEMPLATE/feature_request.md \
  .github/PULL_REQUEST_TEMPLATE.md
git commit -m "docs(community): add contributing, security, conduct, and issue/PR templates"
```

---

## Task 5: `buildIceServers` becomes async with `coturn | none` dispatch

> **Scope note for the implementer:** this task delivers the `async` signature, provider resolution, the `coturn` branch (unchanged), the `none` branch, and array normalization. **Do NOT implement the `cloudflare` provider here** — Task 6 adds it. In this task an unrecognized value (including the literal `cloudflare`) resolves to `coturn` via the unknown-value fallback.

**Files:**
- Modify: `apps/server/src/utils/ice.ts`
- Modify: `apps/server/src/routes/webrtc.ts:15-18`
- Modify: `apps/server/src/routes/ws.ts:798-802`
- Test: `apps/server/test/ice-provider.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks (8b is independent of 8a).
- Produces:
  - `export async function buildIceServers(userId: string): Promise<IceServerConfig[]>` — same name, now async; both call sites `await` it.
  - `export type TurnProvider = 'coturn' | 'none'` (Task 6 widens this to add `'cloudflare'`).
  - `export function resolveTurnProvider(): TurnProvider`
  - `export function toUrlArray(urls: string | string[]): string[]`

- [ ] **Step 1: Write the failing test file**

Create `apps/server/test/ice-provider.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_KEYS = [
  'TURN_PROVIDER',
  'TURN_SECRET',
  'TURN_URL',
  'STUN_URL',
  'TURN_KEY_ID',
  'TURN_KEY_API_TOKEN',
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

async function loadIce(): Promise<typeof import('../src/utils/ice.js')> {
  return await import('../src/utils/ice.js');
}

describe('buildIceServers — provider dispatch (coturn | none)', () => {
  beforeEach(() => {
    vi.resetModules();
    clearEnv();
  });

  afterEach(() => {
    clearEnv();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('unset TURN_PROVIDER resolves to coturn and reproduces the legacy shape', async () => {
    process.env.TURN_SECRET = 'test-turn-secret-123';
    process.env.TURN_URL = 'turn:turn.example.com:3478';
    process.env.STUN_URL = 'stun:stun.example.com:19302';

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toHaveLength(2);
    expect(servers[0]!.urls).toEqual(['stun:stun.example.com:19302']);
    expect(servers[1]!.urls).toEqual([
      'turn:turn.example.com:3478?transport=udp',
      'turn:turn.example.com:3478?transport=tcp',
    ]);

    const [expiryStr, userIdPart] = (servers[1]!.username ?? '').split(':');
    expect(Number(expiryStr)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(userIdPart).toBe('user-1');
  });

  it('TURN_PROVIDER=coturn is identical to the default', async () => {
    process.env.TURN_PROVIDER = 'coturn';
    process.env.TURN_SECRET = 'test-turn-secret-123';
    process.env.TURN_URL = 'turn:turn.example.com:3478';
    process.env.STUN_URL = 'stun:stun.example.com:19302';

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toHaveLength(2);
    expect(servers[1]!.urls).toEqual([
      'turn:turn.example.com:3478?transport=udp',
      'turn:turn.example.com:3478?transport=tcp',
    ]);
  });

  it('TURN_PROVIDER=coturn with no secret falls back to public Google STUN', async () => {
    process.env.TURN_PROVIDER = 'coturn';

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });

  it('TURN_PROVIDER=none returns STUN-only, honouring STUN_URL when set', async () => {
    process.env.TURN_PROVIDER = 'none';
    process.env.STUN_URL = 'stun:stun.example.com:19302';

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.example.com:19302'] }]);
  });

  it('TURN_PROVIDER=none without STUN_URL returns public Google STUN', async () => {
    process.env.TURN_PROVIDER = 'none';

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });

  it('an unrecognized TURN_PROVIDER falls back to coturn instead of throwing', async () => {
    process.env.TURN_PROVIDER = 'bogus';
    process.env.TURN_SECRET = 'test-turn-secret-123';
    process.env.TURN_URL = 'turn:turn.example.com:3478';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('every emitted entry exposes urls as a string array (agent wire shape)', async () => {
    process.env.TURN_SECRET = 'test-turn-secret-123';
    process.env.TURN_URL = 'turn:turn.example.com:3478';
    process.env.STUN_URL = 'stun:stun.example.com:19302';

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    for (const entry of servers) {
      expect(Array.isArray(entry.urls)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/server test -- ice-provider`

Expected: FAIL — `buildIceServers` is synchronous, so `await buildIceServers(...)` returns a non-promise and `servers` is the array already (the first assertions may pass), but the `TURN_PROVIDER=none` and unknown-value tests fail because the current code has no provider dispatch (`none` still returns the coturn/Google-STUN result, and `bogus` does not warn). Confirm at least the `none` and `warn` assertions fail.

- [ ] **Step 3: Rewrite `apps/server/src/utils/ice.ts`**

```ts
import { createHmac } from 'node:crypto';
import type { IceServerConfig } from '@ponter/shared';

const GOOGLE_STUN = 'stun:stun.l.google.com:19302';

/** TURN credentials are valid for one day. */
const TURN_TTL_SECONDS = 86400;

export type TurnProvider = 'coturn' | 'none';

/**
 * Resolve the configured TURN provider.
 *
 * The default is `coturn` — the pre-Phase-8 behaviour — so an unset or empty
 * `TURN_PROVIDER` leaves existing deployments byte-for-byte unchanged. An
 * unrecognized value falls back to `coturn` with a warning rather than
 * throwing: ICE configuration is fetched while a peer is connecting, and a
 * typo in a deployment's `.env` must not break every session.
 */
export function resolveTurnProvider(): TurnProvider {
  const raw = (process.env.TURN_PROVIDER ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'coturn') return 'coturn';
  if (raw === 'none') return 'none';
  console.warn(
    `[ice] unknown TURN_PROVIDER="${raw}"; falling back to "coturn"`,
  );
  return 'coturn';
}

/**
 * Normalize a `urls` value to the array shape the Rust agent parses
 * (`IceServerEntry { urls: Vec<String> }`).
 */
export function toUrlArray(urls: string | string[]): string[] {
  return Array.isArray(urls) ? urls : [urls];
}

function buildCoturnIceServers(userId: string): IceServerConfig[] {
  const turnSecret = process.env.TURN_SECRET;
  const turnUrl = process.env.TURN_URL;
  const stunUrl = process.env.STUN_URL;

  if (!turnSecret || !turnUrl) {
    // STUN_URL is deliberately ignored here: `STUN_URL` configures the STUN
    // entry of a *TURN-enabled* deployment, while this branch is the
    // no-TURN fallback, which is always the public Google resolver.
    return [{ urls: [GOOGLE_STUN] }];
  }

  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
  const username = `${expiry}:${userId}`;
  const credential = createHmac('sha1', turnSecret)
    .update(username)
    .digest('base64');

  // Ensure the turn URL starts with turn:
  const baseTurnUrl = turnUrl.startsWith('turn:') ? turnUrl : `turn:${turnUrl}`;

  return [
    { urls: [stunUrl || GOOGLE_STUN] },
    {
      urls: [`${baseTurnUrl}?transport=udp`, `${baseTurnUrl}?transport=tcp`],
      username,
      credential,
    },
  ];
}

/**
 * STUN-only list. Used by `TURN_PROVIDER=none` and as the fail-soft result
 * when a TURN provider is selected but unavailable. Unlike the coturn
 * no-secret fallback, this honours `STUN_URL` when it is set (ADR-62).
 */
function buildStunOnlyIceServers(): IceServerConfig[] {
  return [{ urls: [process.env.STUN_URL || GOOGLE_STUN] }];
}

/**
 * Build the ICE server list for a user.
 *
 * Provider is selected by `TURN_PROVIDER`:
 *   - `coturn` (default): RFC 5766 HMAC credentials from `TURN_SECRET` +
 *     `TURN_URL`; `STUN_URL` optional.
 *   - `none`: STUN only.
 *
 * Shared by the user-facing `GET /api/webrtc/ice-servers` route and the
 * `ice-servers` frame pushed to agents on connect, so both peers are handed
 * the same shape of configuration. Every emitted `urls` is a string array.
 */
export async function buildIceServers(
  userId: string,
): Promise<IceServerConfig[]> {
  const provider = resolveTurnProvider();

  if (provider === 'none') {
    return buildStunOnlyIceServers();
  }

  return buildCoturnIceServers(userId);
}
```

- [ ] **Step 4: Await the call site in `apps/server/src/routes/webrtc.ts`**

Replace the handler body:

```ts
router.get('/ice-servers', async (c) => {
  const user = c.get('user');
  return c.json({ iceServers: await buildIceServers(user.id) });
});
```

- [ ] **Step 5: Await the call site in `apps/server/src/routes/ws.ts`**

Change the ICE push (inside the already-`async` agent connection handler) to:

```ts
      socket.send(
        JSON.stringify({
          type: 'ice-servers',
          data: { iceServers: await buildIceServers(userId) },
        }),
      );
```

- [ ] **Step 6: Run the new tests and the existing ICE tests**

Run:

```bash
pnpm --filter @ponter/server test -- ice-provider
pnpm --filter @ponter/server test -- agent-ice
pnpm --filter @ponter/server test -- signaling
```

Expected: all PASS. `agent-ice.test.ts` and `signaling.test.ts` are unchanged and must still pass (they do not set `TURN_PROVIDER`, so the default `coturn` path is byte-identical).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @ponter/server typecheck`

Expected: PASS (no call site still treats `buildIceServers` as synchronous).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/utils/ice.ts apps/server/src/routes/webrtc.ts apps/server/src/routes/ws.ts apps/server/test/ice-provider.test.ts
git commit -m "feat(server): make buildIceServers async with TURN_PROVIDER coturn|none (ADR-62)"
```

---

## Task 6: Cloudflare TURN provider

**Files:**
- Modify: `apps/server/src/utils/ice.ts` (widen `TurnProvider`, add the Cloudflare branch + TTL cache)
- Test: `apps/server/test/ice-provider.test.ts` (append a Cloudflare describe block)
- Modify: `apps/agent/src/rtc.rs` (add one test to the existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `resolveTurnProvider`, `toUrlArray`, `buildStunOnlyIceServers`, `buildIceServers` from Task 5.
- Produces: `TurnProvider = 'coturn' | 'cloudflare' | 'none'`; the `cloudflare` branch that mints credentials from the Cloudflare Calls TURN API and caches them for the TTL.

- [ ] **Step 1: Append the failing Cloudflare tests**

Append to `apps/server/test/ice-provider.test.ts`:

```ts
const CLOUDFLARE_URL =
  'https://rtc.live.cloudflare.com/v1/turn/keys/key-123/credentials/generate-ice-servers';

function mockFetchOnce(payload: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  } as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('buildIceServers — cloudflare provider', () => {
  beforeEach(() => {
    vi.resetModules();
    clearEnv();
    process.env.TURN_PROVIDER = 'cloudflare';
    process.env.TURN_KEY_ID = 'key-123';
    process.env.TURN_KEY_API_TOKEN = 'token-abc';
  });

  afterEach(() => {
    clearEnv();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('mints credentials from the Cloudflare API and normalizes urls to arrays', async () => {
    const fetchMock = mockFetchOnce({
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        {
          urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turns:turn.cloudflare.com:5349?transport=tcp',
          ],
          username: 'cf-user',
          credential: 'cf-cred',
        },
      ],
    });

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(CLOUDFLARE_URL);
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers).toMatchObject({
      Authorization: 'Bearer token-abc',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(requestInit.body as string)).toEqual({ ttl: 86400 });

    expect(servers).toHaveLength(2);
    expect(servers[0]!.urls).toEqual(['stun:stun.cloudflare.com:3478']);
    expect(servers[1]!.urls).toEqual([
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
    ]);
    expect(servers[1]!.username).toBe('cf-user');
    expect(servers[1]!.credential).toBe('cf-cred');
  });

  it('caches the minted credentials across calls within the TTL window', async () => {
    const fetchMock = mockFetchOnce({
      iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
    });

    const { buildIceServers } = await loadIce();
    await buildIceServers('user-1');
    await buildIceServers('user-2');

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('missing TURN_KEY_ID / TURN_KEY_API_TOKEN falls soft to STUN-only', async () => {
    delete process.env.TURN_KEY_ID;
    delete process.env.TURN_KEY_API_TOKEN;
    process.env.STUN_URL = 'stun:stun.example.com:19302';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.example.com:19302'] }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-2xx Cloudflare response falls soft to STUN-only', async () => {
    mockFetchOnce({}, false, 403);

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });

  it('a 200 response with a malformed body falls soft to STUN-only', async () => {
    mockFetchOnce({ unexpected: true });

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });

  it('a network failure falls soft to STUN-only without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });
});
```

- [ ] **Step 2: Run the Cloudflare tests to verify they fail**

Run: `pnpm --filter @ponter/server test -- ice-provider`

Expected: FAIL — `TURN_PROVIDER=cloudflare` is not yet recognized, so `resolveTurnProvider` warns and returns `coturn`; the minting tests fail (`fetch` never called).

- [ ] **Step 3: Add the Cloudflare branch to `apps/server/src/utils/ice.ts`**

Add the constant near the top:

```ts
const CLOUDFLARE_API_BASE =
  'https://rtc.live.cloudflare.com/v1/turn/keys';
```

Widen the type:

```ts
export type TurnProvider = 'coturn' | 'cloudflare' | 'none';
```

Update `resolveTurnProvider` to recognize `cloudflare`:

```ts
export function resolveTurnProvider(): TurnProvider {
  const raw = (process.env.TURN_PROVIDER ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'coturn') return 'coturn';
  if (raw === 'cloudflare') return 'cloudflare';
  if (raw === 'none') return 'none';
  console.warn(
    `[ice] unknown TURN_PROVIDER="${raw}"; falling back to "coturn"`,
  );
  return 'coturn';
}
```

Add the cache and the branch (place `buildCloudflareIceServers` after `buildStunOnlyIceServers`):

```ts
/**
 * Cached Cloudflare credentials. Cloudflare mints per-key (not per-user)
 * credentials, so one cached response serves every peer until it expires.
 */
let cloudflareCache: { iceServers: IceServerConfig[]; expiresAt: number } | null =
  null;

function normalizeCloudflareServers(
  raw: unknown,
  fallbackStun: IceServerConfig[],
): IceServerConfig[] {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as { iceServers?: unknown }).iceServers)
  ) {
    return fallbackStun;
  }
  const entries = (raw as { iceServers: IceServerConfig[] }).iceServers;
  if (entries.length === 0) {
    return fallbackStun;
  }
  return entries.map((entry) => ({
    ...entry,
    urls: toUrlArray(entry.urls),
  }));
}

/**
 * Mint short-lived TURN credentials from the Cloudflare Calls TURN API.
 *
 * Fail-soft: a missing key id/token, a non-2xx response, a malformed body, or
 * a network error returns a STUN-only list with a warning. ICE configuration
 * is fetched mid-connect, so a provider outage must not break a session — the
 * same posture as the no-TURN fallback.
 */
async function buildCloudflareIceServers(): Promise<IceServerConfig[]> {
  const keyId = process.env.TURN_KEY_ID;
  const apiToken = process.env.TURN_KEY_API_TOKEN;
  const fallback = buildStunOnlyIceServers();

  if (!keyId || !apiToken) {
    console.warn(
      '[ice] TURN_PROVIDER=cloudflare but TURN_KEY_ID/TURN_KEY_API_TOKEN is missing; falling back to STUN-only',
    );
    return fallback;
  }

  const now = Date.now();
  if (cloudflareCache && cloudflareCache.expiresAt > now) {
    return cloudflareCache.iceServers;
  }

  try {
    const response = await fetch(
      `${CLOUDFLARE_API_BASE}/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
      },
    );

    if (!response.ok) {
      console.warn(
        `[ice] Cloudflare TURN API returned ${response.status}; falling back to STUN-only`,
      );
      return fallback;
    }

    const body = (await response.json()) as unknown;
    const iceServers = normalizeCloudflareServers(body, fallback);
    if (iceServers === fallback) {
      console.warn(
        '[ice] Cloudflare TURN API returned an unexpected body; falling back to STUN-only',
      );
      return fallback;
    }

    cloudflareCache = {
      iceServers,
      expiresAt: now + TURN_TTL_SECONDS * 1000,
    };
    return iceServers;
  } catch (error) {
    console.warn(
      '[ice] Cloudflare TURN API request failed; falling back to STUN-only',
      error,
    );
    return fallback;
  }
}
```

Wire it into `buildIceServers`:

```ts
export async function buildIceServers(
  userId: string,
): Promise<IceServerConfig[]> {
  const provider = resolveTurnProvider();

  if (provider === 'none') {
    return buildStunOnlyIceServers();
  }

  if (provider === 'cloudflare') {
    return buildCloudflareIceServers();
  }

  return buildCoturnIceServers(userId);
}
```

- [ ] **Step 4: Add the agent fixture test to `apps/agent/src/rtc.rs`**

Inside the existing `#[cfg(test)] mod tests`, add (next to `turn_entry_from_the_pushed_frame_becomes_a_credentialed_ice_server`):

```rust
    #[test]
    fn cloudflare_style_turns_url_survives_the_mapping() {
        // Cloudflare TURN returns `turns:` (TLS) URLs alongside `turn:` UDP/TCP.
        // `is_unusable_turn_tcp` drops only `turn:` + `transport=tcp`, so a
        // `turns:` URL must survive the mapping — otherwise the agent silently
        // loses the one transport that works where UDP is blocked.
        let entries = vec![IceServerEntry {
            urls: vec![
                "turn:turn.cloudflare.com:3478?transport=udp".to_string(),
                "turn:turn.cloudflare.com:3478?transport=tcp".to_string(),
                "turns:turn.cloudflare.com:5349?transport=tcp".to_string(),
            ],
            username: Some("cf-user".to_string()),
            credential: Some("cf-cred".to_string()),
        }];

        let servers = ice_servers_from_entries(&entries);
        assert_eq!(servers.len(), 1);
        assert_eq!(
            servers[0].urls,
            vec![
                "turn:turn.cloudflare.com:3478?transport=udp".to_string(),
                "turns:turn.cloudflare.com:5349?transport=tcp".to_string(),
            ],
            "TURN/TCP is dropped but the TLS `turns:` URL survives"
        );
        assert_eq!(servers[0].username, "cf-user");
        assert_eq!(servers[0].credential, "cf-cred");
    }
```

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @ponter/server test -- ice-provider
cargo test --manifest-path apps/agent/Cargo.toml cloudflare_style_turns_url_survives_the_mapping
```

Expected: all PASS. The Rust test confirms the agent consumes Cloudflare's output without an agent change — satisfying the spec's stop condition (risk 1). If the Rust test **fails** (i.e. the mapping drops the `turns:` URL), stop: the spec's stop condition applies and 8b is narrowed to `coturn|none`.

- [ ] **Step 6: Typecheck and full server suite**

```bash
pnpm --filter @ponter/server typecheck
pnpm --filter @ponter/server test
```

Expected: PASS. Confirm `agent-ice` and `signaling` still pass.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/utils/ice.ts apps/server/test/ice-provider.test.ts apps/agent/src/rtc.rs
git commit -m "feat(server): add Cloudflare TURN provider with TTL cache and STUN fail-soft (ADR-62/63)"
```

---

## Task 7: TURN provider env + Compose + docs

**Files:**
- Modify: `docker/.env.example`
- Modify: `docker/docker-compose.prod.yml` (server `environment:` block)
- Modify: `docker/docker-compose.nginx.yml` (server `environment:` block)
- Modify: `docs/guides/deployment.md` (§3 TURN-provider subsection + §5 env table)
- Modify: `docker/README.md` (env table)

**Interfaces:**
- Consumes: the env var names the server reads in Task 5/6 (`TURN_PROVIDER`, `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`).
- Produces: the operator-facing configuration surface. No code.

- [ ] **Step 1: Add the vars to `docker/.env.example`**

After the `STUN_URL`/`TURN_URL` block, append:

```bash
# ---------------------------------------------------------------------------
# TURN provider selection (server) — coturn (default) | cloudflare | none
# ---------------------------------------------------------------------------

# Which TURN provider the server advertises to browsers and agents.
#   coturn     (default) — self-hosted Coturn, RFC 5766 HMAC credentials from
#                          TURN_SECRET + TURN_URL. Unchanged from earlier phases.
#   cloudflare — hosted Cloudflare Calls TURN. Requires TURN_KEY_ID and
#                TURN_KEY_API_TOKEN. Credentials are minted via the Cloudflare
#                API and cached for their TTL; media relays through Cloudflare
#                (~$0.05/GB). See docs/guides/deployment.md.
#   none       — STUN only (no relay). Peers behind symmetric NAT may fail.
# Leave unset to keep the coturn default.
# TURN_PROVIDER=coturn

# Cloudflare Calls TURN credentials — required only when TURN_PROVIDER=cloudflare.
# Create a TURN key in the Cloudflare dashboard (Realtime > TURN).
# TURN_KEY_ID=
# TURN_KEY_API_TOKEN=
```

- [ ] **Step 2: Wire the vars into `docker/docker-compose.prod.yml`**

In the server service's `environment:` list (after the `STUN_URL` entry), add:

```yaml
      - TURN_PROVIDER=${TURN_PROVIDER:-coturn}
      - TURN_KEY_ID=${TURN_KEY_ID:-}
      - TURN_KEY_API_TOKEN=${TURN_KEY_API_TOKEN:-}
```

- [ ] **Step 3: Wire the vars into `docker/docker-compose.nginx.yml`**

Same three lines, in the server service's `environment:` list after the `STUN_URL` entry:

```yaml
      - TURN_PROVIDER=${TURN_PROVIDER:-coturn}
      - TURN_KEY_ID=${TURN_KEY_ID:-}
      - TURN_KEY_API_TOKEN=${TURN_KEY_API_TOKEN:-}
```

- [ ] **Step 4: Add the TURN-provider subsection to `docs/guides/deployment.md`**

At the end of "### Scenario 3: Production VPS (Caddy + Coturn)", add:

```markdown
#### Chọn TURN provider

Server chọn nhà cung cấp TURN qua biến `TURN_PROVIDER`:

| Giá trị | Mô tả |
|---|---|
| `coturn` (mặc định) | Coturn tự host, thông tin xác thực RFC 5766 từ `TURN_SECRET` + `TURN_URL`. Giữ nguyên hành vi các phase trước. |
| `cloudflare` | Cloudflare Calls TURN (hosted). Cần `TURN_KEY_ID` + `TURN_KEY_API_TOKEN`. Server tự mint credential qua API Cloudflare và cache theo TTL. **Lưu ý:** media đi qua hạ tầng Cloudflare (bên thứ ba), tính phí ~$0.05/GB — khác với mô hình tự host. |
| `none` | Chỉ STUN, không relay. Peer sau symmetric NAT có thể không kết nối được. |

Khi Cloudflare lỗi (thiếu config, non-2xx, lỗi mạng), server tự hạ cấp về STUN-only và ghi warning — kết nối không bị chặn.
```

- [ ] **Step 5: Add the env rows to the `docs/guides/deployment.md` §5 table**

Add three rows to the environment-variable table:

```markdown
| `TURN_PROVIDER` | No | `coturn` | Nhà cung cấp TURN: `coturn` \| `cloudflare` \| `none`. |
| `TURN_KEY_ID` | Cloudflare only | — | Cloudflare Calls TURN key ID. Bắt buộc khi `TURN_PROVIDER=cloudflare`. |
| `TURN_KEY_API_TOKEN` | Cloudflare only | — | Cloudflare TURN API token (Bearer). Bắt buộc khi `TURN_PROVIDER=cloudflare`. |
```

- [ ] **Step 6: Add the env rows to the `docker/README.md` table**

Add three rows to the "## Environment Variables" table:

```markdown
| `TURN_PROVIDER`            | No          | `coturn`                | TURN provider: `coturn` \| `cloudflare` \| `none`.                                                 |
| `TURN_KEY_ID`              | Cloudflare only | —                   | Cloudflare Calls TURN key ID (required when `TURN_PROVIDER=cloudflare`).                           |
| `TURN_KEY_API_TOKEN`       | Cloudflare only | —                   | Cloudflare TURN API token (required when `TURN_PROVIDER=cloudflare`).                              |
```

- [ ] **Step 7: Validate Compose and formatting**

```bash
cd /mnt/Data/Ponta/remote-platform
docker compose -f docker/docker-compose.prod.yml config >/dev/null && echo "prod compose OK"
docker compose -f docker/docker-compose.nginx.yml config >/dev/null && echo "nginx compose OK"
pnpm exec prettier --check docker/README.md
```

Expected: both compose files parse; `docker/README.md` passes prettier. (`docker/.env.example` and `docs/**` are not prettier-gated.)

- [ ] **Step 8: Commit**

```bash
git add docker/.env.example docker/docker-compose.prod.yml docker/docker-compose.nginx.yml docs/guides/deployment.md docker/README.md
git commit -m "docs(docker): document TURN_PROVIDER + Cloudflare credentials (ADR-62)"
```

---

## Task 8: Roadmap & docs reconciliation

**Files:**
- Modify: `docs/ARCHITECTURE.md` (Phase 8 entry; the file has a "### Phase 7: Agent Desktop App (Tuần 19-20)" section around line 1007)
- Modify: `docs/README.md` (index — the self-hosting entry lands in Task 1; this task adds the spec/plan to the design-specs and plans listings if they are enumerated)
- Modify: `docs/superpowers/specs/2026-10-08-phase8-selfbuild-and-turn-design.md` (status line → approved/executing)

**Interfaces:**
- Consumes: the merged SHAs of Tasks 1-7.
- Produces: the roadmap reflects Phase 8. Docs only.

- [ ] **Step 1: Read the Phase 7 section and the roadmap tail**

```bash
cd /mnt/Data/Ponta/remote-platform
sed -n '1000,1030p' docs/ARCHITECTURE.md
```

- [ ] **Step 2: Add the Phase 8 entry**

Append a "### Phase 8: Open-Source Self-Build + Provider-Selectable TURN" section after the Phase 7 section, stating: the two workstreams (8a self-build enablement, 8b TURN provider), the ADRs (59-63), the merged PR/commit for each workstream, and the spec/plan paths:

```markdown
### Phase 8: Open-Source Self-Build + Provider-Selectable TURN

> **Phase 8 (2026-10-08).** Hai workstream độc lập: **8a** bật self-build/self-host (build-from-source cho cả 4 app, fork & self-host guide, Docker self-publish, community files) — giữ nguyên bản sắc tác giả (ADR-60); **8b** TURN chọn nhà cung cấp qua `TURN_PROVIDER=coturn|cloudflare|none` (mặc định `coturn`, không đổi hành vi hiện hữu — ADR-62/63). Chi tiết: spec `docs/superpowers/specs/2026-10-08-phase8-selfbuild-and-turn-design.md` (ADR-59..63), plan `docs/superpowers/plans/2026-10-08-phase8-selfbuild-and-turn.md`. Merged: 8a `<sha>`, 8b `<sha>`.
```

Fill in the two `<sha>` placeholders with the real merge commits once Tasks 1-7 are merged.

- [ ] **Step 3: Update the spec status line**

In `docs/superpowers/specs/2026-10-08-phase8-selfbuild-and-turn-design.md`, change the status line to:

```markdown
- **Status:** Approved (owner 2026-10-08); implementation executing — plan `docs/superpowers/plans/2026-10-08-phase8-selfbuild-and-turn.md`
```

- [ ] **Step 4: Verify and commit**

```bash
cd /mnt/Data/Ponta/remote-platform
grep -n 'Phase 8' docs/ARCHITECTURE.md
git add docs/ARCHITECTURE.md docs/superpowers/specs/2026-10-08-phase8-selfbuild-and-turn-design.md docs/README.md
git commit -m "docs(architecture): record Phase 8 self-build + TURN provider workstreams"
```

---

## Verification gates (run before opening the PRs)

**8a (docs + script):**
- [ ] `pnpm format:check` passes (root README + community files are checked; `docs/**` is ignored).
- [ ] The Task 3 stub-`pnpm` harness prints the expected passthrough, overlay, and half-set (`exit=2`) results.
- [ ] Every cross-doc link resolves (`self-hosting.md` referenced from README, `docs/README.md`, `docker/README.md`, `deployment.md`).
- [ ] No badge, repo link, Docker image name, or `plugins.updater` value was changed in the committed tree.

**8b (server code):**
- [ ] `pnpm --filter @ponter/server test` passes, including the untouched `agent-ice` and `signaling` suites.
- [ ] `pnpm --filter @ponter/server typecheck` passes.
- [ ] `cargo test --manifest-path apps/agent/Cargo.toml` passes, including the new `cloudflare_style_turns_url_survives_the_mapping` fixture.
- [ ] `cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets -- -D warnings` and `cargo fmt --manifest-path apps/agent/Cargo.toml --check` pass.
- [ ] Test-integrity: no existing test deleted/skipped/weakened; any touched test file's `it()`/`expect()` counts reported before→after.

**Cross-cutting:**
- [ ] Full CI green (Node, E2E, Sonar, agent matrix, desktop matrix).
- [ ] No change to `packages/shared`, `apps/agent/src/signal.rs`, or any `ui/**` path.

## Test-integrity declaration

- **New files:** `apps/server/test/ice-provider.test.ts` (additive).
- **Modified test file:** `apps/agent/src/rtc.rs` — one test **added**; no existing test removed, renamed, or weakened. Report the `#[test]` count before → after.
- **Existing ICE tests** (`apps/server/test/agent-ice.test.ts`, `apps/server/test/signaling.test.ts`) are **not modified**; they must keep passing unchanged (regression pin for the coturn default).

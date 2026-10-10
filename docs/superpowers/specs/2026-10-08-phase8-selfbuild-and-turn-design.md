# Phase 8: Open-Source Self-Build Enablement + Provider-Selectable TURN — Design Spec

- **Status:** Approved (owner 2026-10-08); implemented/merged — 8a PR #69 `00048bc`, 8b PR #70 `c1aeb91`; plan `docs/superpowers/plans/2026-10-08-phase8-selfbuild-and-turn.md`
- **Phase:** 8 (roadmap continuation after Phase 7; `docs/ARCHITECTURE.md` §8)
- **Owner decisions (2026-10-08):**
  - Ponter is **open source (MIT)**; third parties can **clone, build, and self-host** it.
  - **Author branding stays intact.** The official repo, badges, links, Docker Hub image, and the desktop updater pubkey/endpoint remain the author's (`ngotuananh101`). Self-builders override or disable, never the reverse.
  - **Both workstreams ship in Phase 8:** (8a) self-build/self-host enablement, then (8b) Cloudflare TURN provider-selectable.
  - Self-builder auto-update: **both paths documented** — default = disable, optional = env-driven override.
  - TURN: `TURN_PROVIDER=coturn|cloudflare|none`, **default `coturn`** (backward-compatible).
  - Community/docs additions: build-from-source for all 4 apps, fork & self-host guide, Docker self-publish guide, community files.
- **Related:** `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater`), `.github/workflows/build-desktop.yml`, `apps/server/src/utils/ice.ts`, `apps/server/src/routes/webrtc.ts`, `apps/server/src/routes/ws.ts`, `packages/shared/src/types/webrtc.ts`, `apps/agent/src/signal.rs` (`IceServerEntry`), `docs/guides/deployment.md`, `docs/guides/development.md`, `docs/guides/agent-setup.md`, `docker/README.md`.

---

## 1. Why Phase 8, and what "done" means here

Phases 1-7 delivered a complete, working remote-access platform: backend, web client, terminal, desktop streaming, file transfer, E2EE, low-latency interaction, and a packaged desktop app with signed auto-update. The repository is now **public and MIT-licensed**, so its audience is no longer only the author's own deployment — a third party can clone it and stand up their own instance.

Two gaps block that audience today:

1. **Self-build friction.** Nothing in the tree tells a newcomer how to build the four apps from source, and the desktop app ships with the **author's** updater public key and update endpoint compiled in — a self-built copy would silently poll the author's releases and refuse anything else. There is no documented way to fork, re-point, or disable it.
2. **TURN provider lock-in.** `buildIceServers()` (`apps/server/src/utils/ice.ts`) supports exactly one TURN shape: a self-hosted **coturn** server with RFC 5766 HMAC credentials. An operator who cannot or will not run coturn has no supported alternative, even though a hosted provider (Cloudflare Calls TURN) is a one-line API change away.

**"Done" for this phase means:**

1. A newcomer can go from `git clone` to a running self-hosted stack (server + web + agent + desktop) by following the docs, with every author-specific default either preserved-as-official or documented as overridable.
2. The desktop app can be self-built **without the author's signing key**, either with auto-update disabled or with the self-builder's own update endpoint + pubkey.
3. An operator can select `TURN_PROVIDER=coturn|cloudflare|none` via environment; `coturn` (the current behaviour) remains the default and is byte-for-byte unchanged for existing deployments.
4. The repository carries the community hygiene files expected of an open-source project (contribution, security, conduct, templates).
5. The existing CI (Node, E2E, Sonar, agent matrix, desktop matrix) stays green; no protocol, security-model, or E2EE change.

**Risk note (recorded):** the two workstreams are independent — 8a is documentation-plus-config, 8b is server code. They are ordered **8a first** because it is near-zero-risk and directly serves the "users can self-build" driver the owner named; 8b follows as a normal TDD code task. Neither blocks the other.

---

## 2. Current state, re-verified against the tree at `c53cd6f`

- **Desktop updater config is author-specific.** `apps/desktop/src-tauri/tauri.conf.json` `plugins.updater` = `{ pubkey: "dW50cnVzdGVk…" (author's minisign public key), endpoints: ["https://github.com/ngotuananh101/ponter/releases/latest/download/latest.json"], requireSignedVersion: true }`. Tauri v2 does **not** interpolate environment variables inside `tauri.conf.json`.
- **Desktop build is config-overlay driven.** `.github/workflows/build-desktop.yml` enables updater artifacts only on the tag/dispatch path via `tauri build --config '{"bundle":{"createUpdaterArtifacts":true}}'`, reading `TAURI_SIGNING_PRIVATE_KEY` / `…_PASSWORD` secrets. The PR path builds with **zero secrets**.
- **TURN is a single provider.** `buildIceServers(userId)` reads `TURN_SECRET` + `TURN_URL` (+ `STUN_URL`); with neither TURN var set it falls back to public Google STUN. It is called from two already-async sites: `routes/webrtc.ts:17` (`GET /api/webrtc/ice-servers`) and `routes/ws.ts:798` (the `ice-servers` frame pushed to agents).
- **The ICE shape is shared and mirrored.** `packages/shared/src/types/webrtc.ts` `IceServerConfig = { urls: string | string[]; username?: string; credential?: string }`; the Rust agent mirrors it as `IceServerEntry { urls: Vec<String>, username: Option<String>, credential: Option<String> }` (`apps/agent/src/signal.rs:154`). The agent parses `urls` as a **list**.
- **Docker is author-published.** `docker/docker-compose.{local,tunnel,prod,nginx}.yml` and `docs/guides/deployment.md` reference `<your-dockerhub-username>/ponter`; CI (`docker-publish.yml`) publishes the author's image. Scenario 1 (Local LAN) already builds from source.
- **No community files.** No `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, or `.github/ISSUE_TEMPLATE/` / `PULL_REQUEST_TEMPLATE.md` exist.
- **Docs are operational, not build-oriented.** `docs/guides/development.md` covers local dev setup; there is no per-app "build a release artifact from source" guide, and no fork/self-host guide.

---

## 3. Architecture decisions (ADR-59 to ADR-63)

### ADR-59: Phase 8 is two independently shippable workstreams — 8a (self-build enablement) and 8b (TURN provider)

8a is documentation plus a small, non-invasive config/script surface; 8b is server code with tests. They touch disjoint files and ship as separate PRs. Ordering: **8a first** (lowest risk, highest alignment with the open-source driver), 8b second. Either can be delivered without the other; the phase is "done" only when both are merged.

### ADR-60: The author's identity is preserved; self-build is enabled by documented override, never by removal

Badges, repository links, the Docker Hub image, and the desktop updater `pubkey`/`endpoints` stay the author's for the official build. Self-builders are supported by **documentation and optional, opt-in mechanisms** — they edit their own fork or pass a build-time override. This spec adds no code that strips or rewrites author branding, and changes no default that would alter the official artifacts.

### ADR-61: Desktop auto-update is opt-out for self-builders — documented default plus an optional env-driven override

A self-built desktop app must not inherit the author's update channel. Two documented paths, in priority order:

1. **Default (docs): disable.** The self-builder removes or empties the `plugins.updater` block in their fork's `apps/desktop/src-tauri/tauri.conf.json` before building. Result: no signing key required, no auto-update. This is the recommended path and requires no new code.
2. **Optional (script): override.** A build helper reads `PONTER_UPDATE_ENDPOINT` and `PONTER_UPDATE_PUBKEY` from the environment and invokes `tauri build --config '<json overlay>'` that merges the self-builder's own endpoint + pubkey. The official config is untouched. This lets a self-hoster publish their own signed updates.

The official build path is unchanged: it keeps the author's pubkey/endpoint and the existing tag/dispatch `createUpdaterArtifacts` overlay.

### ADR-62: TURN is provider-selectable — `TURN_PROVIDER=coturn|cloudflare|none`, default `coturn`

`buildIceServers()` dispatches on `TURN_PROVIDER`:

- **`coturn` (default):** current behaviour, byte-for-byte — RFC 5766 HMAC credentials from `TURN_SECRET` + `TURN_URL`, `STUN_URL` optional. Existing deployments are unaffected; an unset `TURN_PROVIDER` resolves to `coturn`.
- **`cloudflare`:** mint short-lived credentials from the Cloudflare Calls TURN API (`POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers`, `Authorization: Bearer $TURN_KEY_API_TOKEN`, body `{"ttl": <seconds>}`), cache the response for the credential TTL, and return the resulting `iceServers` array. **On a missing/invalid config or a non-2xx API response, fall soft to STUN-only and log a warning** — the same posture as the existing no-TURN fallback, chosen so neither call site (the `GET` route nor the `ws.ts` agent push) breaks a connection on a provider outage.
- **`none`:** STUN only (the existing no-TURN fallback: public Google STUN, or `STUN_URL` when set).

The function becomes **async** (both call sites are already `async`). Provider selection is server-only; no web, agent, desktop, or protocol change.

### ADR-63: The ICE server list keeps one shared shape; provider differences are normalized server-side

`IceServerConfig` (`packages/shared/src/types/webrtc.ts`) and the Rust `IceServerEntry` stay **unchanged**. `buildIceServers()` normalizes each provider's output into that shape:

- Every `urls` value is emitted as a **string array** (the agent parses `urls: Vec<String>`; Cloudflare may return a bare string — the server wraps it).
- The `coturn` provider keeps emitting its current two-URL TURN entry (`?transport=udp` + `?transport=tcp`) under one credential pair.
- The `cloudflare` provider passes through the provider's `urls` verbatim (including any `turns:` TLS URLs), wrapped into the array shape.

This keeps the wire contract stable and confines all provider-specific logic to `apps/server/src/utils/ice.ts`.

---

## 4. Scope decisions

### 4.1 One spec, two workstreams

This spec covers both 8a and 8b; the implementation plan will break them into separate task groups. 8a is documentation-dominant with one optional script; 8b is a single-module server change with tests.

### 4.2 What is *not* changing

- **No branding changes.** Author badges, links, Docker image name, and the official updater pubkey/endpoint are untouched.
- **No protocol or security-model change.** The ICE frame shape, E2EE, WS2 identity, and input gates are unchanged.
- **No new dependency for 8b beyond `fetch`** (Node 24 global `fetch`) — no HTTP client crate/package added.
- **No default-behaviour change** for existing deployments: `TURN_PROVIDER` defaults to `coturn`; the desktop build defaults to the author's updater.

### 4.3 Self-build support is additive documentation + opt-in config

8a adds docs and, at most, one build helper script (ADR-61 path 2). It does not restructure the build, change CI, or remove any existing capability.

### 4.4 Community files are the standard set

`CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/` (bug + feature), and `.github/PULL_REQUEST_TEMPLATE.md`. Content is the project's own (English, matching repo convention), not a copied template with placeholder author names.

---

## 5. Component changes

### 5.1 8a — Self-build / self-host enablement

| Area | Change |
|---|---|
| `docs/guides/development.md` | Add a "Build release artifacts from source" section for all four apps (server, web, agent, desktop) with prerequisites, commands, and output paths. |
| New `docs/guides/self-hosting.md` | Fork & self-host guide: change the desktop updater endpoint/pubkey, change the Docker image, change the default server URL; includes the disable-vs-override decision (ADR-61). |
| `docs/guides/deployment.md` / `docker/README.md` | Add a "build & publish your own image" path (Docker self-publish) alongside the existing "pull the author's image" path. |
| `apps/desktop/scripts/build-self.sh` (new, optional path) | Reads `PONTER_UPDATE_ENDPOINT` / `PONTER_UPDATE_PUBKEY`, calls `tauri build --config '<overlay>'`; a no-op passthrough when the vars are unset. Documented, not wired into CI. |
| Root files | `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`, `.github/PULL_REQUEST_TEMPLATE.md`. |
| `README.md` | Add a short "Self-hosting & building from source" pointer to the new guides (no badge/link changes). |

### 5.2 8b — Cloudflare TURN provider-selectable

| File | Change |
|---|---|
| `apps/server/src/utils/ice.ts` | `buildIceServers` becomes `async`; dispatch on `TURN_PROVIDER`; `coturn` branch unchanged; new `cloudflare` branch (API call + TTL cache); `none` branch = STUN-only; normalize all `urls` to arrays (ADR-63). |
| `apps/server/src/routes/webrtc.ts` | `await buildIceServers(user.id)` (call site already async). |
| `apps/server/src/routes/ws.ts` | `await buildIceServers(userId)` (call site already async). |
| `apps/server/src/utils/ice.test.ts` (or existing test file) | Unit tests: provider dispatch, `coturn` output unchanged, `cloudflare` mocked-`fetch` output normalized to arrays, `none` = STUN only, unset `TURN_PROVIDER` → `coturn`, Cloudflare API error → documented fallback/throw. |
| `docker/.env.example`, `docker/docker-compose.{prod,nginx}.yml` | Document `TURN_PROVIDER`, `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`; keep `TURN_SECRET`/`TURN_URL` for coturn. |
| `docs/guides/deployment.md` | New "TURN provider" subsection: coturn (default), Cloudflare (with cost + third-party-relay disclosure), none. |

---

## 6. Testing strategy

- **8a:** documentation changes are checked by `pnpm format:check` and (for the new script) `shellcheck`/manual run; the build helper is exercised by a self-build smoke (env unset → passthrough; env set → overlay applied) in the local gates. No product test changes.
- **8b:** unit tests in the server package with `fetch` mocked:
  - `TURN_PROVIDER` unset → identical output to today's coturn path (regression pin).
  - `TURN_PROVIDER=coturn` → RFC 5766 HMAC credential shape unchanged.
  - `TURN_PROVIDER=cloudflare` → calls the documented endpoint with `Authorization: Bearer` + `{"ttl"}`, and returns the provider's servers **normalized to array `urls`**.
  - `TURN_PROVIDER=none` → STUN-only (public Google STUN, or `STUN_URL` when set).
  - Cloudflare API non-2xx or missing `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` → **fail-soft to STUN-only + warning log** (pinned by a test).
  - Both call sites await the async function (typecheck + the existing route tests).
- **Test-integrity:** no existing test is deleted or weakened. New tests are additive; any modification to an existing ICE test is declared before→after with reason.

---

## 7. Risks and stop conditions

1. **Agent cannot parse Cloudflare's `urls` shape (highest for 8b).** Cloudflare may return `urls` as a bare string and/or `turns:` TLS URLs on port 443/5349; the Rust `IceServerEntry` expects `urls: Vec<String>`. **Mitigation:** ADR-63 normalizes to arrays server-side; the plan must **verify the agent accepts a `turns:` URL** and add a fixture test. **Stop condition:** if the agent cannot consume the Cloudflare output without an agent change, 8b is narrowed to `coturn|none` and Cloudflare is deferred (agent change would be a separate task).
2. **Cloudflare cost / third-party relay tension.** Cloudflare TURN includes a **1,000 GB/month free egress tier** (shared with Cloudflare's SFU/WebSocket adapter) and bills **~$0.05/GB egress beyond it**; it relays media through a third party — in tension with the self-hosted ethos. **Mitigation:** documented truthfully in the deployment guide; the feature is opt-in and off by default.
3. **Self-build docs drift.** Build commands change as tooling evolves. **Mitigation:** the build-from-source guide is exercised in the plan's verification (a real build of at least server + web; agent + desktop where CI-verifiable).
4. **Tauri env interpolation misconception.** Tauri v2 does not interpolate env in `tauri.conf.json`. **Mitigation:** ADR-61 uses a `--config` overlay, not interpolation; the spec calls this out explicitly.
5. **Scope creep into branding/rename.** A "make it generic" instinct would fight the owner's "keep the author" decision. **Mitigation:** ADR-60 is binding; any change that strips author identity is out of scope.

---

## 8. Definition of done — exit gates

1. **8a-docs:** a newcomer can build server, web, agent, and desktop from source by following `docs/guides/development.md` + the new guides; every author-specific default is either preserved-as-official or documented as overridable.
2. **8a-updater:** the desktop app can be self-built with auto-update **disabled** (documented config edit) and, optionally, **re-pointed** via `PONTER_UPDATE_ENDPOINT` + `PONTER_UPDATE_PUBKEY`; the official build path is unchanged.
3. **8a-community:** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and the issue/PR templates exist and are project-specific.
4. **8b:** `TURN_PROVIDER=coturn|cloudflare|none` selects the provider; default (unset) = `coturn` with byte-identical output to today; `cloudflare` mints credentials via the documented API and returns normalized array `urls`; `none` = STUN only. All pinned by unit tests with `fetch` mocked.
5. **Cross-cutting:** the full existing CI (Node, E2E, Sonar, agent matrix, desktop matrix) stays green; no test deleted or weakened; no branding/protocol/security change.

---

## 9. Explicitly out of scope

- Renaming the project, removing author badges/links, or changing the official Docker image or updater key.
- Any change to `apps/agent` (unless risk 1 forces a follow-up task, which would be scoped separately).
- Mobile (`apps/mobile`).
- A hosted/multi-tenant control plane; Phase 8 keeps the self-hosted single-operator model.
- Publishing a self-builder's image or releases on their behalf; the guides describe the steps, the operator runs them.

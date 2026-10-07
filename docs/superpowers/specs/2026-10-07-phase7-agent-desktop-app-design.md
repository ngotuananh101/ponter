# Phase 7: Agent Desktop App — Design Spec

- **Status:** Draft (owner-approved design 2026-10-07; spec pending review)
- **Phase:** 7 — Agent Desktop App (roadmap Tuần 19-20; `docs/ARCHITECTURE.md` §8)
- **Owner decisions (2026-10-07):** embed runtime (refactor to lib); all three platforms (Linux + macOS + Windows); full scope including installer/tray/auto-update; account login = existing email/password + OS keychain; auto-update = Tauri updater + signed manifest + GitHub Releases.
- **Related:** `docs/ARCHITECTURE.md` §8 (Phase 7 stub), §3 (tech stack: Tauri 2.0), §7 (security); `apps/agent/src/main.rs` (CLI to refactor); `apps/agent/src/identity.rs` (WS2 Ed25519 identity); `apps/server/src/routes/agents.ts` (device registration, one-time credential); `apps/server/src/routes/auth.ts` (`POST /api/auth/login`); `.github/workflows/build-agent.yml` (existing 6-target agent matrix); `.github/workflows/ci-node.yml` (already path-filtered on `apps/desktop/**`).

---

## 1. Why Phase 7, and what "done" means here

Phases 1-6 delivered the backend, web client, terminal, desktop streaming, file transfer, E2EE, and low-latency interaction. The operator-facing surface is still a **CLI binary**: `ponter-agent` is started by hand with `--agent-id`, `--credential`, `--allow-input`, etc. (`apps/agent/src/main.rs` `Cli`). Phase 7 packages that runtime as a **desktop application** a non-technical operator can install, log into, configure, and run.

**"Done" for this phase means:**
1. A single installable desktop app that embeds the agent runtime (no separate CLI process to launch).
2. Account login (email/password), device registration/management, and a visual setup wizard (server URL, screen-capture permission, input gate, auto-start).
3. Runs as a background/tray app with auto-start on login, packaged as a native installer per platform.
4. Self-updates from signed releases.
5. The existing CLI keeps working byte-for-byte (it becomes a thin wrapper over the same library), so the Phase 1-6 E2E and `build-agent.yml` matrix do not regress.

**Risk note (recorded):** the owner selected the maximal scope — three platforms plus installer/tray/auto-update — for a single week. This spec structures execution in layers (ADR-58) so a partial delivery is still a coherent, shippable slice. §8 defines the per-layer definition of done; stopping at any layer boundary is a valid, documented outcome, not a failure.

---

## 2. Current state, re-verified against the tree at `c810293`

- **`apps/agent` is a binary crate with no `lib.rs`.** `main.rs` is ~3000+ lines; modules (`cursor`, `desktop`, `e2ee`, `files`, `identity`, `input`, `logging`, `pty`, `rtc`, `shell_policy`, `signal`) are declared in `main.rs` and their unit tests live in inline `#[cfg(test)] mod tests`. `main.rs:8-12` documents that a `lib.rs` was deliberately avoided because only integration tests would need it and the PTY echo test uses the real binary path. Phase 7 reverses that decision for a concrete reason: the Tauri backend must call the runtime as a library.
- **Desktop/mobile are empty stubs.** `apps/desktop/package.json` and `apps/mobile/package.json` contain only `lint`/`typecheck` = `echo ok`. `ci-node.yml` already path-filters `apps/desktop/**` and `apps/mobile/**`, so wiring a real app there will trigger the Node CI automatically.
- **Framework is already chosen in docs.** `ARCHITECTURE.md` §3 and `docs/README.md` name **Tauri 2.0** for desktop and **Tauri Mobile** for mobile.
- **Device registration exists.** `POST /api/agents` (`apps/server/src/routes/agents.ts`) mints a credential (`ag_...`) returned **once**, stores only its hash, enforces `maxAgentsPerUser`. The agent presents that credential on the WS connect.
- **Login exists.** `POST /api/auth/login` (`apps/server/src/routes/auth.ts`) issues an access token (default 900s) + rotating refresh token (default 7d) with reuse detection.
- **Identity is persisted.** `apps/agent/src/identity.rs` generates and persists an Ed25519 PKCS#8 key (`agent-identity.pkcs8`) with owner-only perms; used for the WS2 proof-of-possession and the E2EE session binding.
- **Agent release pipeline exists.** `build-agent.yml` builds 6 targets (linux gnu/musl/arm64, macOS x64/arm64, Windows msvc) and publishes a GitHub Release with SHA256 checksums.

---

## 3. Architecture decisions (ADR-50 to ADR-58)

### ADR-50: `apps/agent` becomes a library plus a thin binary; the Tauri backend embeds the runtime

- **Decision.** Split `apps/agent` into:
  - `src/lib.rs` — the crate root exposing an `AgentRuntime` API (start/stop/status, plus a `wait()` to await natural end) and the existing modules as `pub(crate)`/`pub` as needed.
  - `src/main.rs` — a **thin** CLI that parses `Cli` (unchanged flags), constructs `AgentRuntime`, and drives it. Its behaviour is identical to today's binary.
- **Why.** The Tauri backend (`apps/desktop/src-tauri`) must start, stop, and observe the agent **in-process** — a separate process would need lifecycle supervision, credential plumbing over argv/pipe, and a second copy of the identity store. Embedding reuses the exact WS2 identity and E2EE code paths with no duplication.
- **Compatibility contract.** The CLI binary's observable behaviour does not change: same flags (`--agent-id`, `--server`, `--credential`/`AGENT_CREDENTIAL`, `--identity-path`, `--stun`, `--desktop-source`, `--allow-input`, …), same log lines, same WS protocol. The existing `build-agent.yml` verify gate (fmt/clippy/test/build) and the cross-language E2E must stay green — they are the regression net for this refactor.
- **Cost if wrong.** A large refactor of a 3000-line `main.rs`; mitigated by moving code without logic changes and keeping tests passing at each step.

### ADR-51: Desktop UI is Vue 3 + Vite inside Tauri 2.0; strict capabilities and CSP

- **Decision.** The Tauri frontend uses the **same stack as the web client** (Vue 3 + Vite + TypeScript). Tauri 2.0's per-window **capabilities** are restricted to the minimum command set; the webview CSP is locked down (no remote script, no `unsafe-eval`).
- **Why.** Stack consistency means the existing lint/typecheck/vitest tooling and the team's familiarity carry over. Tauri 2's capability model is the security boundary: the webview must not be able to invoke arbitrary shell or filesystem commands.
- **Boundary.** All privileged work (keychain, filesystem, process, updater) goes through **explicitly declared Tauri commands** in the Rust backend; the frontend never gets a general-purpose IPC bridge.

### ADR-52: Credentials and identity are stored in the OS keychain, never in webview storage

- **Decision.** The agent credential (`ag_...`) and the refresh token are stored in the **OS secret store** — Linux Secret Service (libsecret/gnome-keyring), macOS Keychain, Windows Credential Manager — via a keychain crate in the Rust backend. The Ed25519 identity key stays as the existing PKCS#8 file (ADR unchanged from WS2), with the app resolving its path to the app data dir. The webview `localStorage`/IndexedDB is **not** used for any secret.
- **Why.** A desktop app's webview storage is trivially readable and not the right place for a long-lived device credential. The keychain gives OS-managed protection at rest and per-user access control.
- **Login reuse.** Login calls the existing `POST /api/auth/login`; the backend stores the refresh token in the keychain and holds the short-lived access token in memory only.

### ADR-53: The setup wizard verifies real capability, not just collects strings

- **Decision.** The wizard has explicit steps and each has a **verification**, not only an input field:
  1. **Server** — enter the signaling/server URL; the wizard probes reachability (`GET /api/health` or equivalent) and reports success/failure before continuing.
  2. **Screen permission** — trigger a real capture probe through the same `desktop` code path the agent uses (X11 direct; Wayland via the portal path, which is the recorded limitation — see §4.4); report the observed result. On macOS, guide the user to grant Screen Recording in System Settings and re-probe.
  3. **Input gate** — a clearly-worded toggle mirroring `--allow-input` (Gate A of ADR-42), defaulting **off**, with the two-gate explanation (Gate A here + Gate B peer identity at admission) shown verbatim from the ADR-42 posture.
  4. **Auto-start** — opt-in; installs the platform auto-start entry (ADR-55).
- **Why.** The CLI's failure modes (wrong URL, missing capture permission, gate confusion) are exactly what a GUI should turn into a guided, verified step. Collecting a string and failing at runtime would waste the operator's time.

### ADR-54: Device registration reuses `POST /api/agents`; the one-time credential lands in the keychain

- **Decision.** The app registers a device by calling the existing `POST /api/agents` (id + hostname/platform/osVersion/capabilities) with the logged-in user's token, receives the one-time `credential`, and **immediately writes it to the keychain**. The identity keypair is generated locally (WS2) and its public key is proven at first WS connect (unchanged flow).
- **Why.** No new server endpoint is needed; the existing contract (credential returned exactly once, only its hash stored) already matches a "register once, store securely" desktop flow.
- **Device management.** Listing/deleting devices reuses `GET /api/agents` and `DELETE /api/agents/:id`, so the app's "manage devices" view mirrors the web dashboard.

### ADR-55: Tray icon and auto-start are per-platform, behind one backend API

- **Decision.** A tray icon shows connection state (connected / connecting / disconnected / error) with a menu: Start/Stop agent, Open window, Open at login (toggle), Quit. Auto-start uses the platform-native mechanism — Linux `~/.config/autostart/*.desktop`, macOS `SMAppService`/LaunchAgent, Windows registry `Run` key (or Task Scheduler) — selected in the Rust backend behind a single `set_autostart(bool)` command.
- **Why.** A remote-access agent is expected to run without a visible window; tray + auto-start is the standard expectation and the tray is the only UI when the window is closed.
- **Lifecycle.** Closing the window hides to tray (does not stop the agent); Quit stops the runtime and exits.

### ADR-56: Packaging produces native installers per platform via Tauri bundler; CI builds all three

- **Decision.** Tauri bundler produces: Linux `.deb` and `.AppImage`; macOS `.dmg` (universal or per-arch); Windows `.msi` (and/or NSIS `.exe`). A **new** `build-desktop.yml` workflow builds these on a matrix (`ubuntu-latest`, `macos-14`, `windows-latest`) and uploads them as artifacts, attaching them to a GitHub Release on tag.
- **Why.** `build-agent.yml` is path-filtered to `apps/agent/**` and produces raw binaries, not installers; a desktop app needs its own workflow. The installers are the deliverable an operator actually installs.
- **Note.** The webview assets are built by the existing Node/Vite toolchain; the desktop workflow installs pnpm + Rust + the Tauri system deps per OS.

### ADR-57: Auto-update uses the Tauri updater with a signed manifest on GitHub Releases

- **Decision.** The app checks a Tauri updater endpoint (a static JSON manifest, e.g. `latest.json`, hosted on GitHub Releases) and updates in place when a newer signed version exists. Artifacts are signed with a Tauri updater keypair; the **public** key is compiled into the app, the **private** key is a CI secret used only at release time.
- **Why.** Tauri's updater is the framework-native, signed, in-place update path; hosting the manifest on GitHub Releases reuses the release pipeline.
- **Owner action required (blocking for L5):** generate the updater keypair (`tauri signer generate`) and add the private key + password as CI secrets. Without it, L5 cannot ship — this is a named dependency, not an implementation detail.

### ADR-58: Layered execution (L0-L5) with a stop-safe boundary at every layer

- **Decision.** Phase 7 is executed as six layers, each independently shippable:
  - **L0 — Feasibility spike (gating):** a minimal Tauri shell that embeds the (already-refactored or stub-linked) agent runtime and starts it under Xvfb on Linux. If this cannot be made to work, the embedding decision (ADR-50) is revisited **before** any further work.
  - **L1 — Refactor + shell + login + keychain:** lib/bin split, Tauri app boots, login works, secrets in keychain.
  - **L2 — Wizard + device registration/management.**
  - **L3 — Tray + auto-start.**
  - **L4 — Packaging + 3-OS CI.**
  - **L5 — Auto-update.**
- **Why.** The owner chose maximal scope; layering converts a binary pass/fail into a monotone sequence where each layer leaves a working artifact. Stopping after L3 yields a usable app without installers; stopping after L4 yields installable apps without auto-update.
- **Gating.** L0 must pass before L1 starts. L1 must not regress `build-agent.yml` or the E2E suite.

---

## 4. Scope decisions

### 4.1 One spec, layered execution
A single spec covers all six layers; the implementation plan is one plan with tasks grouped by layer, in L0→L5 order. Each layer's tasks are self-contained and testable.

### 4.2 What is *not* changing
The signaling protocol, WS2 identity binding, E2EE session keys, the desktop/terminal/files session semantics, and the server API are **unchanged**. Phase 7 is a packaging and operator-UX layer over the existing runtime. Any temptation to change the wire or the security model is out of scope.

### 4.3 Desktop app is a *peer client of the existing server*, not a new server surface
The app talks to the same self-hosted server. It adds no server routes except where a genuine gap is found (none is anticipated; registration, login, and device CRUD all exist).

### 4.4 Platform capture posture is inherited, not re-solved
The agent's existing platform limitations carry over verbatim: Wayland capture is portal-dependent (recorded limitation, ADR-27/ADR-45 precedent); Windows uses the WGC backend (per `apps/agent/Cargo.toml`); musl builds are terminal-only. The wizard surfaces these honestly rather than hiding them. Phase 7 does not attempt to close the Wayland capture gap.

### 4.5 Mobile stays out of scope
`apps/mobile` remains a stub. Tauri Mobile is named in the roadmap as future work; Phase 7 covers desktop only.

---

## 5. Component changes (all additive except the agent refactor)

| Area | Change |
|---|---|
| `apps/agent/src/lib.rs` | **New** crate root; exposes `AgentRuntime` (start/stop/status + `wait()`) + modules. |
| `apps/agent/src/main.rs` | **Refactor** to a thin CLI over `AgentRuntime`; behaviour identical. |
| `apps/agent/Cargo.toml` | Add `[lib]` target; keep `[[bin]]` (`ponter-agent`). |
| `apps/desktop/src-tauri/` | **New** Tauri 2.0 Rust backend: commands (login, register device, wizard probes, set_autostart, updater), keychain integration, path-dep on `ponter-agent`. |
| `apps/desktop/src/` | **New** Vue 3 frontend: login view, wizard, device manager, tray-driven status. |
| `apps/desktop/package.json` | Real `dev`/`build`/`lint`/`typecheck`/`test` scripts replacing the stub. |
| `apps/desktop/src-tauri/tauri.conf.json` | Window config, CSP, capabilities, bundler targets, updater endpoint + public key. |
| `.github/workflows/build-desktop.yml` | **New** 3-OS build + bundle + release workflow. |
| `apps/web/src/components/security/EncryptionByChannelDialog.vue` | **Edit** — widen the dialog (owner request; see §5.1). |

### 5.1 Widening the "Encryption by Channel" dialog (owner request, 2026-10-07)
The owner asked for the dialog to be **wider horizontally** ("rộng thêm một chút"). The width override must use the **same `sm:` variant** as the generated `DialogContent` default: the default is `sm:max-w-md`, and an unprefixed `max-w-*` sits in a different tailwind-merge group, so it does not replace the default and `sm:max-w-md` still wins at ≥640px. The dialog therefore passes `class="sm:max-w-2xl"` on `DialogContent` — tailwind-merge replaces the default, giving an effective width of 42rem (2xl) at ≥640px. The width test pins this merge-replacement (contains `sm:max-w-2xl`; not `sm:max-w-md`; not `max-w-3xl`; keeps the mobile cap `max-w-[calc(100%-2rem)]`). This is a small, independent task and is **not** part of the Phase 7 runtime work — it ships first.

---

## 6. Testing strategy

| Layer | What proves it |
|---|---|
| Agent refactor (L1) | `cargo test` (all existing unit tests) + `cargo clippy -D warnings` + `cargo fmt --check` green; `build-agent.yml` verify gate green; cross-language E2E green (proves the CLI path unchanged). |
| Tauri backend (L1-L3) | Rust unit tests for pure logic (URL probe result mapping, autostart path selection, updater decision); Tauri command handlers tested where they do not require a display. |
| Frontend (L1-L3) | Vitest for wizard state machine, login form, device list; the same `@vue/test-utils` setup as the web app. |
| Shell boot (L0, L3) | Smoke test: the app process starts, the runtime reaches "connecting"/"connected" against a local server under Xvfb (Linux CI); tray presence asserted where headless-testable. |
| Packaging (L4) | `build-desktop.yml` produces the expected installer artifacts on each OS; a post-build check asserts the files exist and are non-trivial size. |
| Auto-update (L5) | Updater decision unit-tested (newer/older/equal version, signature-verify failure → refuse); an end-to-end update is documented as a manual procedure if it cannot run in CI. |
| Regression | The full existing suite (Node CI, E2E, Sonar) must stay green throughout; the agent refactor is the highest-risk change and is guarded by `build-agent.yml` + E2E. |

**Mutation discipline.** The load-bearing guards for this phase are: (a) the agent CLI's flag behaviour (mutating a flag's effect must turn a test red), (b) the input-gate default is closed (mutating the default to open must turn a test red), (c) secrets never reach webview storage (a test/assert that the keychain path is used and no secret is written to `localStorage`), (d) the updater refuses an unsigned/older manifest (mutation must turn a test red).

---

## 7. Risks and stop conditions

1. **Scope vs one week (highest).** Three platforms + installer/tray/auto-update is a large body of work. **Mitigation:** layered execution (ADR-58); each layer is a stop-safe boundary. **Stop condition:** if L0 or L1 is not green, do not proceed to L2+; report and re-plan.
2. **Agent refactor regressions.** Splitting a 3000-line `main.rs` can break subtle behaviour. **Mitigation:** move code without logic changes; keep `build-agent.yml` + E2E as the net; do the refactor as the first L1 task with tests green after every step. **Stop condition:** if the E2E or verify gate cannot be made green within the layer, revert the split and reconsider ADR-50.
3. **macOS/Windows build + test cannot be verified locally.** The dev machine is Linux. **Mitigation:** CI matrix is the verification surface for those platforms; anything not CI-verifiable is documented as such. **Stop condition:** if a platform's build fails on CI and cannot be fixed in-layer, ship that platform as "build-only, not smoke-tested" with the limitation documented, rather than blocking the others.
4. **Tauri system dependencies on Linux CI.** WebKitGTK/`libsoup` etc. must be installed in CI. **Mitigation:** follow Tauri's documented Linux deps; cache them.
5. **Updater keypair is an owner dependency.** **Stop condition:** L5 does not start until the owner provides the updater signing key as a CI secret.
6. **Wayland capture limitation is inherited.** The wizard must not promise Wayland capture parity. **Mitigation:** honest status text (ADR-53 step 2), consistent with the project's truthful-disclosure posture.

---

## 8. Definition of done — exit gates

Per-layer, each gate is independently checkable:

1. **L0 (gating):** a Tauri shell embedding the agent runtime starts the runtime under Xvfb on Linux and reaches a connected state against a local server; the spike result is written to `docs/spikes/`. **If this fails, ADR-50 is reopened before L1.**
2. **L1:** `apps/agent` is lib+bin; `build-agent.yml` verify + E2E green; the Tauri app boots, logs in via `POST /api/auth/login`, and stores the refresh token in the OS keychain (verified: no secret in webview storage).
3. **L2:** the wizard completes all four steps with verification; device registration creates an agent and the credential is in the keychain; the device list/delete view mirrors the web dashboard.
4. **L3:** the tray icon reflects connection state and controls start/stop; auto-start toggles the platform-native entry.
5. **L4:** `build-desktop.yml` produces `.deb` + `.AppImage` (Linux), `.dmg` (macOS), `.msi` (Windows); artifacts attach to a release.
6. **L5:** the app detects and applies a signed update; the updater refuses an unsigned or older manifest (test-pinned).
7. **Cross-cutting:** the dialog-width change (§5.1) is shipped and its test green; the full existing CI (Node, E2E, Sonar, agent) stays green.

---

## 9. Explicitly out of scope

- Tauri **Mobile** (`apps/mobile`) — future phase.
- New server endpoints or protocol changes.
- Closing the Wayland capture gap or the macOS/Windows capture feature gaps beyond what the agent already does.
- Multi-account / multi-tenant UI in the desktop app (one logged-in user per install, matching the web client).
- Any change to the E2EE / WS2 / input-gate security model.

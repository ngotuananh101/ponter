# Phase 6a — Interactive Desktop Demo Walkthrough

**Date:** 2026-10-07
**Machine:** Fedora Linux (X11), loopback WebRTC + Xvfb
**Agent:** `apps/agent` built debug via `cargo build --manifest-path apps/agent/Cargo.toml`; web at `apps/web`
**Branch HEAD:** `feat/phase6a-interactive-desktop`

## Status

**Not observed manually.** This walkthrough is a *runnable script*: each step is the command(s) you would run and the observation you would make. The figures in the "Measured baseline" section are **cited** from the cross-language E2E suite (`packages/webrtc-core/test/e2e/desktop.e2e.test.ts`), not re-measured here. This doc (Task 10) is docs-only and reconciles the architecture; it is not a re-measurement.

## Security posture

- **Two gates, both required for injection (ADR-42):** (A) `--allow-input` / `AGENT_ALLOW_INPUT`, set by the operator locally — a remote peer cannot open it; and (B) peer identity verified at admission by `verify_offer_identity` (ADR-41). A missing one of the two drops every input frame. The agent default is `false` (input closed), preserving the Week 9 gate-closed contract verbatim.
- **ADR-41 admission gate closes C1 for every mode:** `verify_offer_identity` is hoisted to run before the mode dispatch in `run_one_session`, so Terminal, Desktop, Files, and unknown-capability offers all fail closed. A proof-less offer bails with **no answer of any kind** — not even `approved: false` — so an unverifiable peer learns nothing.
- **Input default OFF.** `allow_input` defaults to `false`; there is no live input-forwarding path while both gates are not satisfied.
- See the sibling security notes: `docs/security/2026-10-08-ws1-e2ee-rust.md` (WS1 terminal E2EE) and `docs/security/2026-10-01-e2ee-zero-trust-audit.md` (adversarial audit).

---

## Steps

### 1. Start the agent with `--allow-input` under Xvfb

```bash
# Build the agent (debug), then run with --allow-input under a virtual framebuffer.
cargo build --manifest-path apps/agent/Cargo.toml --locked

# Xvfb provides the headless X server the injection assertions run against.
# (Start it once per session: Xvfb :99 -screen 0 1280x720x24 &)
DISPLAY=:99 ./apps/agent/target/debug/ponter-agent \
  --agent-id agent-myhost-01 \
  --server ws://localhost:8787/api/ws/agent \
  --credential ag_0123456789abcdef0123456789abcdef \
  --stun "" \
  --desktop-source test \
  --allow-input
```

**Expected observation:**
- Agent log line `starting ponter-agent` (INFO); on connect, INFO `connected to the signaling server`.
- `RUST_LOG` defaults to `info`; the `--allow-input` flag opens Gate A locally only — a remote peer still cannot toggle it.

### 2. Open a desktop session from the web UI and observe the two-gate UI

Navigate to the local web client (e.g. `http://localhost:3000`), connect, and open a **Desktop** session.

**Expected observation:**
- The **"Verified peer"** badge renders (`data-test="desktop-peer-verified"`) — proof that the offer carried a valid identity proof and passed the ADR-41 admission gate. A pre-6a agent (which omits the `peerVerified` field) hides the badge and hides the input toggle entirely (no false claim in either direction).
- The status line reads **"View only"** (`data-test="desktop-input-status"`) — the peer is verified but the local `--allow-input` toggle is off, so injection is still held by Gate A.
- Click **Input** (the `data-test="desktop-input-toggle"`: it is rendered only when `desktopInputEnabled && desktopPeerVerified`).
- The status line flips to **"Controlling"** — both gates are now closed-laterally-open, and `desktop-input` frames are admitted (subject to the ADR-43 cap).

### 3. Run the flood and latency E2E tests

These are the cross-language tests that pin ADR-43 (flood cap) and ADR-44 (baseline latency). They run against the freshly built agent binary under `DISPLAY=:99`.

```bash
cargo build --manifest-path apps/agent/Cargo.toml --locked
DISPLAY=:99 pnpm --filter @ponter/webrtc-core exec vitest run --config vitest.e2e.config.ts test/e2e/desktop.e2e.test.ts
```

**Expected observation:**
- `caps a flooding peer at 120 Hz and keeps the session alive` — PASS: at least one `desktop-input applied` and at least one `dropping desktop-input: rate cap exceeded` appear, and a post-burst frame in the next window still injects (session survives).
- `measures the input-latency baseline (ADR-44)` — PASS: each `delta_ms` (agent receive − browser send) is ≤ 1000 ms.

---

## Measured baseline (ADR-44)

```
[ADR-44 baseline] n=10 min=0ms median=0ms p90=1ms max=1ms
```

The line above is the exact summary printed by the E2E test `measures the input-latency baseline (ADR-44)` in `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` (it echoes `[ADR-44 baseline] n=... min=...ms median=...ms p90=...ms max=...ms` via `console.log`). It is **cited**, not re-measured here.

CI command that produced it:
```bash
DISPLAY=:99 pnpm --filter @ponter/webrtc-core exec vitest run --config vitest.e2e.config.ts test/e2e/desktop.e2e.test.ts
```
and the grep used to recover the summary line:
```bash
grep "ADR-44 baseline" /tmp/phase6a-latency.log
```

**Caveat:** loopback + Xvfb — the real-network delta (real WebRTC path, not the in-memory transport) is a separate Phase 6b measurement.

## What this demonstrates end-to-end

All four live in `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` (the desktop block is `describe.skipIf(!isLinux)`), except the files refusal which lives in `packages/webrtc-core/test/e2e/files.e2e.test.ts`.

| Capability | Where it's shown | Mechanism | E2E test title |
|---|---|---|---|
| Proof-less offer is refused (no answer) | Step 2 / Step 3 | ADR-41 hoist: `verify_offer_identity` before mode dispatch bails with `?` | `refuses a proof-less desktop offer (ADR-41 admission gate)` (desktop); `refuses a proof-less files offer even with a valid root (ADR-41)` (files) |
| Two gates for input | Step 2 | Gate A `--allow-input` (operator-local) AND Gate B verified identity; both flags drive the UI | `injects a pointer-move when the gate is open under Xvfb` (also asserts the badge/status) |
| Flood cap engages, session survives | Step 3 | Fixed-window `InputRateLimiter` at 120 Hz after decrypt + Gate A, before inject | `caps a flooding peer at 120 Hz and keeps the session alive` |
| Latency baseline | Step 3 | `info!` success log with `delta_ms = (now_ms − envelope.timestamp).max(0)`; summary echoed by the test | `measures the input-latency baseline (ADR-44)` |

## Non-goals

- **Phase 6b items** — WebCodecs low-latency pipeline, `playoutDelayHint`/jitter-buffer tuning, client-side cursor prediction, and the hardware codec spike (ADR-25) — are out of scope here; they get a separate 6b spec and measurement.
- **Windows / macOS / Wayland injection** — the injection tests are Linux/X11-only (`isLinux`; `xdotool` under Xvfb). No other platform is claimed.
- **Terminal badge** — the "Verified peer" badge is desktop-only (ADR-42 §6.3); the terminal path's identity verification is asserted by the existing `identity.e2e.test.ts` proof-less test, not by a UI badge.

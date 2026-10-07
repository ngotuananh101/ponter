# P1 — Playwright Headless WebRTC Smoke Spike (ADR-49)

- **Task:** Phase 6b L0 probe P1 (plan Task 1)
- **Date:** 2026-10-07
- **Branch:** `feat/phase6b-low-latency`
- **Base commit at probe time:** `bfcedc26d08c86d884b4d6b2cab9adfb5ec650b2`
- **Author:** QA Engineer session (independent probe; not a spec/plan implementation task)

## Verdict: **ADOPT**

Headless Chrome can reliably drive the full desktop session — connect, first video
track, `desktop-sources`/`desktop-stats`, an injected input echo, and the applied
playout knob observable via `evaluate` — against a fresh Rust agent binary. Four
consecutive end-to-end runs were green with a **~230 ms** time-to-first-`desktop-stats`
and **~2.5 s** total wall clock. The ADR-49 adopt branch is satisfied on the evidence.

One caveat on scope, not reliability: the probe used **system Google Chrome**
(`channel: 'chrome'`) because the repo has no Playwright browser and downloading
Chromium was out of the timebox. A CI job adopting this must pin the browser
(see §5).

---

## 1. What was proven (the ADR-49 proof list)

ADR-49 asks the spike to prove, against a fresh agent binary under Xvfb:

| # | Proof item | Result | Evidence |
|---|------------|--------|----------|
| 1 | **Connect** | ✅ | `RTCPeerConnection.connectionState === 'connected'`; tab reaches `active` |
| 2 | **First track** | ✅ | remote video track resolved; `<video>.srcObject` set |
| 3 | **`desktop-sources` visible** | ✅ | UI shows `desktop-stats` `1280×720 · 30 fps · 6.0 Mbps` (emitted on the `control` channel only after the agent answers) |
| 4 | **One injected input echo** | ✅ | with `--allow-input`, 8 × `desktop-input applied` in the agent log; toggle shows `Controlling` |
| 5 | **Applied playout knob observable via `evaluate`** | ✅ | on the **app's real receiver**: `jitterBufferTarget` set to `100`, `playoutDelayHint` set to `0.1` (both writable) |

Bonus, from the same run: the ADR-41/42 **`peerVerified` badge** rendered
(`[data-test="desktop-peer-verified"]`), i.e. the browser signed an offer proof
with its IndexedDB Ed25519 key and the agent accepted it — the whole Phase 6a
admission gate holds under a real browser, not just the Node werift harness.

## 2. Reliability (ADR-49: "CI reliability first")

Four identical runs of the full-stack probe (register → agent → connect):

| Run | `ok` | time-to-`desktop-stats` | total wall clock | video frame |
|-----|------|--------------------------|------------------|-------------|
| 1 | ✅ | 237 ms | 2.55 s | 1280×720 |
| 2 | ✅ | 228 ms | 2.20 s | 1280×720 |
| 3 | ✅ | 218 ms | 2.17 s | 1280×720 |
| 4 | ✅ | 232 ms | 2.47 s | 1280×720 |

Plus a DISPLAY-less run (§4) and the input-echo run — **6/6 green, zero flakes**.
The variance in connect time is ±10 ms; the whole probe is an order of magnitude
below the 120 s E2E timeout budget.

## 3. Execution duration / cost

- Full-stack probe end-to-end: **~2.2–2.5 s** (server + Vite already warm; the
  probe's own stack spin-up is ~1.5 s of the total).
- Cold start (server + Vite + first Chrome launch) adds ~5–8 s.
- Screenshot artifact written on the happy path.

## 4. Xvfb is not required for the video path

The desktop **video** path uses `--desktop-source test` (a deterministic in-process
pattern, no display), and headless Chrome runs its own compositor. Verified:

- `feasibility.mjs` with `DISPLAY` **unset** → connect ✅, track ✅, receiver knobs ✅, frame ✅.
- `p1-probe.mjs` (full stack) with `DISPLAY` **unset** → `ok: true`, `connectMs 243`.

So a video-only Playwright smoke needs **no Xvfb**. Xvfb (`:99`) is required only
for the **input-injection** proof (item 4), because the agent's `enigo` injector
needs an X server — matching the existing E2E harness, which sets `DISPLAY=:99`
only on `--allow-input` tests. The probe was run under Xvfb `:99` for the primary
evidence and re-run without it to confirm this.

## 5. What a CI adoption would require (for the plan's decision)

The spike answers *feasibility*, not *packaging*. To adopt per ADR-49 ("one smoke
spec runs in CI with the same discipline as the E2E job"):

1. **Browser:** add Playwright as a devDependency of `@ponter/webrtc-core` (or a new
   `test/browser` workspace) and **pin the browser** — either
   `playwright install chromium --with-deps` in the CI job, or `channel: 'chrome'`
   against a Chrome the runner already has. Do **not** rely on a dev machine's
   system Chrome. This was the one thing the probe could not settle inside the
   timebox (the repo currently has zero browser automation, spec §2 item 14).
2. **Harness reuse:** reuse `packages/webrtc-core/test/e2e/harness.ts`'s server +
   agent spawn (`setupE2E`, `seed`, `spawnAgent`, `waitForAgentOnline`,
   `waitForAgentSigningKey`) so the browser smoke shares one process/port discipline
   (exclusive 8787, fresh binary, `fileParallelism: false`).
3. **Web client:** the probe served `apps/web` from the Vite dev server
   (`vite --host 127.0.0.1 --port 5173`, `VITE_API_URL=http://127.0.0.1:8787`).
   A CI smoke can do the same (`vite build` + `vite preview`, or a dev server).
   Note `apps/web` calls the API **cross-origin**; the server must allow the web
   origin (`CORS_ORIGIN`) — the probe used `CORS_ORIGIN=*` for the throwaway run.
4. **Identity keys:** the probe registers **through the UI** (`/register`), which
   generates the ECDH + Ed25519 keys into IndexedDB that the offer proof needs
   (ADR-41). A smoke that seeds a token via `localStorage` instead must also seed
   the IndexedDB signing key, or the agent will fail-closed and refuse the offer.
   Registering through the UI is the simplest faithful path.
5. **Xvfb:** only if the smoke asserts input injection. The video-only smoke needs
   no display.

## 6. Probe design (what was actually run)

Throwaway scripts (preserved in the git-ignored SDD workspace, **not committed**):

- `.superpowers/sdd/2026-10-07-phase6b-low-latency/p1-probe-artifacts/feasibility.mjs`
  — minimal loopback WebRTC in headless Chrome (canvas → video), proves the
  receiver knobs exist and are writable.
- `.../p1-probe.mjs` — full stack: spawns server (`tsx src/index.ts`, port 8787,
  `E2E_AUTO_APPROVE_USERS=true`) and Vite; launches Chrome; registers through the
  UI; creates an agent via REST (`capabilities: ['desktop']`); spawns the real
  `ponter-agent` binary (`--desktop-source test`, fresh `--identity-path`); clicks
  `[data-test="connect-desktop-<id>"]`; waits for `[data-test="desktop-stats"]`;
  then inspects the app's real `RTCPeerConnection` (captured via `addInitScript`)
  for the receiver and the knobs.
- `.../p1-echo.mjs` — the same with `--allow-input`, moving the pointer over the
  video and grepping the agent log for `desktop-input applied`.

### Environment

| Tool | Version |
|------|---------|
| Node | v24.21.0 |
| pnpm | 12.6.0 |
| Google Chrome | 154.0.8037.97 (system, `channel: 'chrome'`) |
| Playwright (pkg) | 1.63.0 (installed in a throwaway dir, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`) |
| Xvfb | `:99 -screen 0 1280x1024x24` |

### Key observed values

```json
{
  "ok": true,
  "connectMs": 237,
  "video": true, "videoWidth": 1280, "videoHeight": 720, "framePresent": true,
  "connState": "connected",
  "realReceiverFound": true,
  "jitterBufferTarget": true, "playoutDelayHint": true,
  "jbtSet": 100, "pdhSet": 0.1,
  "peerVerifiedBadge": true
}
```

## 7. Conclusion and recommendation to the plan

- **Decision: ADOPT.** Reliability is not in question — 6/6 green, sub-300 ms connect,
  no flakes. The manual-fallback branch (ADR-49 "document") is **not** triggered.
- The smoke should assert the ADR-49 proof list (connect → first track →
  `desktop-sources`/`desktop-stats` → one input echo → applied knob via `evaluate`),
  and can additionally carry the ADR-47 glass-to-glass protocol as ADR-49's adopt
  branch requires.
- **Open packaging item for the plan:** pin the browser in CI (devDependency +
  `playwright install`, or a runner-provided Chrome). The probe proved the browser
  *can* do it; choosing the pinned browser is the plan's call, not the spike's.
- Xvfb is needed only for the input-echo assertion; the video-only smoke is
  display-independent.

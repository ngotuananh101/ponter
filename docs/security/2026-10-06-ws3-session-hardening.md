# WS3 Session Hardening — Threat Model & Enforcement Points

**Date:** 2026-10-06
**Layer:** 3 (WS3) of Phase 5's three-layer design
**Scope:** the four session-layer findings closed this week — H1, H2, M2, M3.

## Deliverables

1. **Shell allowlist (H1).** `resolve_shell_value` returned any client-supplied
   string unmodified, and the dispatcher passed it to `CommandBuilder::new` —
   arbitrary binary execution on the agent host. A client-supplied
   `terminal-create.shell` is now resolved through `ShellPolicy`
   (`apps/agent/src/shell_policy.rs`): absolute path, canonicalized, exists, is
   a file, executable (unix), and a member of the allowlist — the configured
   `--shell`/`AGENT_SHELL`, the unix floor (`/bin/sh`, `/bin/bash`,
   `/usr/bin/sh`, `/usr/bin/bash`), and every entry in `/etc/shells`. A refusal
   is a `terminal-error` frame with the pinned `pty-spawn-failed` code and a
   message beginning "shell refused:"; no PTY is spawned. The implicit
   spawn-on-demand path uses the trusted configured shell and is not gated.

2. **`approved` enforced server-side (H2).** `recordSignal`
   (`apps/server/src/utils/signals.ts`) transitioned `pending → active` on any
   answer, so a refusal (ADR-14) activated the session it declined. The
   transition is now gated on `message.data.approved !== false`. The refusal
   answer is **still inserted and relayed** — the browser's fast-fail
   (`refused-answer.test.ts`) reads it — and the session stays `pending`.

   **The client half was already shipped.** `connection.ts` refuses an
   `approved: false` answer (never applies the SDP, fails `waitForChannel`
   fast) since commit `2de7a23` (2026-10-01), which predates this workstream.

3. **Close-code handling (M2).** `SignalClient::run` returned `Ok(())` on any
   close, so the reconnect loop in `run_with_reconnect` retried even after
   `4409` (replaced) and `4401` (unauthorized). `run` now returns a `RunEnd`:
   `Terminal(4409 | 4401)` stops the process (supervisor aborted, exit 0);
   everything else — `1000`, `1001`, no close frame, read errors — is
   `Transient` and reconnects with the existing backoff. `1001`-reconnects is
   load-bearing: the server-restart E2E (`terminal-ws.e2e.test.ts`) requires a
   live agent to survive a server kill.

4. **`candidate.session_id` validation (M3) — already fixed; now tested.**
   The guard in `route_inbound` (`apps/agent/src/main.rs`) drops a candidate
   whose `session_id` is not the live session, and logs it. It landed in
   `2de7a23` (2026-10-01) and is present at the spec baseline `fdead292` — the
   spec's §2 table marks M3 CONFIRMED in error. WS3 adds the regression E2E
   and a mutation proof (guard removed → red) rather than re-implementing it.

## Trust boundary

- The configured shell is **operator-trusted**; the allowlist constrains
  *client* input, not the operator's own deployment choice.
- `/etc/shells` is admin-maintained; an entry added there is an intentional
  grant of shell access to every client of every agent on the host.
- A refused shell and a refused session are both **visible** to the browser
  (a `terminal-error` frame; a relayed `approved: false` answer). Silent
  refusals are treated as defects.

## What this does NOT close

- **Input forwarding (ADR-29) stays closed.** H1 and H2 are its two named
  prerequisites, but opening the gate is Phase 6 work (spec §8).
- **E2EE (WS1)** — payload encryption starts Week 15. WS3 does not encrypt.
- **Agent-host hardening beyond the shell choice** — env scrubbing, cwd
  confinement, and resource caps are out of scope for WS3.

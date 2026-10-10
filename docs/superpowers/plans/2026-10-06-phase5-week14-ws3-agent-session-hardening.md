# Phase 5 Week 14 — WS3 Agent Session Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four remaining session-layer findings of the Phase 5 audit — H1 (client-controlled `shell` → arbitrary binary execution), H2-server (a refused session still activates), M2 (the agent reconnects on every close code, flapping against 4409/4401), and M3 (candidate `session_id` validation, fixed but untested) — so that Layer 3 of Phase 5 is complete and WS1 (E2EE) can start from a hardened session layer.

**Architecture:** WS3 is the last piece of Layer 3 of the three-layer Phase 5 design. Three enforcement points change: the **Rust agent** gains a shell allowlist (`ShellPolicy`) gating every client-supplied `terminal-create.shell`, and a close-code classifier (`RunEnd`) that lets only transient closes reach the reconnect loop; the **server** gates the `pending → active` transition in `recordSignal` on `approved !== false`. M3 already holds in the code (guard in `route_inbound`) and gains its missing regression coverage plus a mutation proof. The refusal paths reuse existing wire contracts end to end: a disallowed shell is refused with the already-pinned `terminal-error`/`pty-spawn-failed` frame, and a refused answer is still recorded and relayed to the browser — it just never activates the session.

**Tech Stack:** Rust 1.85+ (std only — no new crates), TypeScript, Hono 4.x, Drizzle ORM, better-sqlite3, Vitest; the cross-language E2E harness (`packages/webrtc-core/test/e2e/`) against the real binary and the real server.

**Spec:** `docs/superpowers/specs/2026-10-05-phase5-zero-trust-e2ee-design.md` (§2, §3.3, §5, §7, §8)

## Design decisions (owner review required before execution)

The spec fixes *what* WS3 must close (§3.3) but not *how*. These are the implementation decisions this plan makes; each is called out again in the owning task.

1. **H1 — allowlist model.** The configured `--shell` / `AGENT_SHELL` is operator-trusted and always allowed (it is this agent's own deploy-time policy). A **client-supplied** `create.shell` must canonicalize (symlinks resolved) into the allowlist: a small platform floor (`/bin/sh`, `/bin/bash`, `/usr/bin/sh`, `/usr/bin/bash` on unix) + every path in `/etc/shells` (admin-maintained) + the configured shell. The resolved path must exist, be a file, and have an execute bit (unix). The gate lives at the single client entry point, the `terminal-create` dispatcher arm (`main.rs:1011`); the implicit spawn-on-demand (`main.rs:1096`) keeps using the trusted configured shell and needs no gate.
2. **H1 — refusal reuses the pinned wire contract.** A disallowed shell is refused with a `terminal-error` frame carrying `code: "pty-spawn-failed"` and a message naming the policy violation. This deliberately avoids adding a third code: `pty-spawn-failed`/`session-limit-reached` are pinned as a wire contract (`pty.rs:602`), and the browser already surfaces the frame's `message` (there is no code switch to extend). **No FE work**: all production callers (`WorkspaceView.vue`) never pass `shell`, and `stores/terminal.ts` already wires `client.onError` to a toast.
3. **H2 — server-only fix; the client half already shipped.** The client's `approved === false` fast-fail already exists in `connection.ts` (added by `5ef6bd5`, pinned by `refused-answer.test.ts`). The remaining gap is server-side: `recordSignal` (`apps/server/src/utils/signals.ts`) transitions `pending → active` on *any* answer. The fix gates the transition on `message.data.approved !== false`. The refusal answer **must still be recorded and relayed** — the browser's fast-fail depends on reading it.
4. **M2 — stop semantics.** Only `4409` (replaced) and `4401` (unauthorized) stop the process; **everything else reconnects** — `1000`, `1001`, no close frame, IO errors, idle timeout. `1001`-reconnects is load-bearing: the server-restart E2E (`terminal-ws.e2e.test.ts:171`) kills the server under a live agent and requires it to come back. The classifier is a pure function (`classify_close`) unit-tested without a socket.
5. **M3 — already fixed, needs proof.** The candidate guard in `route_inbound` (`main.rs:2027`) landed in `5ef6bd5` (2026-10-01), which is an ancestor of both the spec baseline `680cccc0` and `main`. **Spec §2's table is stale for M3 ("CONFIRMED") and for H2's client half ("nothing enforces")** — both were fixed before the spec's baseline. WS3 therefore does not re-implement M3; it adds the missing regression E2E, a mutation proof that the test is load-bearing, and a documented spec erratum (Task 7). `webrtc` 0.21's `PeerConnection` trait is sealed, so `route_inbound` cannot be unit-tested with a mock — E2E is the only honest coverage.
6. **No new dependencies, no new wire fields.** Rust uses `std` only; TypeScript adds nothing. `TerminalCreateMessage.shell` stays as-is (`Option<String>`); no shared type changes.
7. **ADR-29 stays closed.** WS3 closes H1 and H2 — the two prerequisites ADR-29 names — but opening input forwarding is explicitly out of scope (spec §8). No task may flip `--allow-input` / `AGENT_ALLOW_INPUT`.
8. **Docs deliverables (Task 7).** A new `docs/security/2026-10-06-ws3-session-hardening.md` (mirroring the WS2 doc), a correction to the now-false sentence in `docs/guides/handshake-connection-flow.md:155`, and a dated erratum in the spec's §2 table for the H2/M3 rows.

## Global Constraints

- **Layer order is a gate.** WS3 MUST NOT implement WS1 (E2EE / `EncryptionManager` / AES-GCM / session keys) — no payload encryption anywhere. WS3 is the last WS before WS1 (Week 15).
- **Fail-closed everywhere.** A client shell that is not provably in the allowlist must not spawn. A session whose answer was refused must not activate. A close code that is not provably transient must not reconnect — and one that is provably terminal must not.
- **Do not regress the 19 verified-good controls** (spec §2.1), in particular: the `4409` stale-guard (`ws.ts:736`), the `1001` graceful-shutdown close, and the server-restart reconnect behavior (`terminal-ws.e2e.test.ts`).
- **Do not regress the pinned wire contracts:** `pty-spawn-failed` / `session-limit-reached` spellings (`pty.rs` test "A rename here is a breaking change nobody would notice"), the `offer`/`answer`/`ice-candidate` envelope, and `approved` normalization (`approved: inner.approved !== false`) in `shared/signaling.ts` and `ws.ts`.
- **`apps/web/src/components/ui/` is generated.** Never hand-modify it. WS3 touches no web file at all — verify that, do not "improve" the UI path.
- **Commit discipline:** path-limited commits only (`git commit -m "..." -- <paths>`). Never `git add .`. Never `git stash`.
- **Sonar new-code gate:** keep new code non-duplicated (extract helpers rather than copy-paste); test files count toward duplication — do not clone test blocks, parameterize them.
- **Language:** code, commit messages, and technical docs in English. Conversation replies in Vietnamese.

## Review Focus

The failure modes the spec implies but no single task's happy-path test exercises. Each line's test is added in the owning task, in that task's own step style.

1. **A shell path that lies about itself.** Symlink pointing outside the allowlist, relative path, `..` traversal, nonexistent path, a directory, and a non-executable file must all be refused; the configured shell must always pass. → Task 1 (unit) and Task 6 (E2E).
2. **Enforcement that swallows the refusal.** Gating `approved` server-side must not stop the refusal answer from being recorded and relayed — the browser's fast-fail (`refused-answer.test.ts`) reads it. → Task 2.
3. **A transient close treated as terminal.** `1001` (server going away), no close frame, and IO errors must still reconnect — the server-restart E2E is the guard. → Task 3 (unit) and the existing `terminal-ws.e2e.test.ts:171` (must stay green).
4. **An evicted agent that flaps.** After `4409` the old agent must exit and stay exited — a reconnect would evict the newcomer in turn. → Task 4 (E2E).
5. **A foreign candidate applied to a live session.** A candidate for session B delivered while session A is live must be dropped by A, and A must stay healthy. The test must be mutation-proven (guard removed → red). → Task 5.
6. **A refused shell that still leaves a half-open terminal.** The refusal must arrive as a `terminal-error` frame and no PTY output may ever follow for that terminal id. → Task 6.

---

### Task 1: Shell allowlist for client-supplied shells (H1)

**Files:**
- Create: `apps/agent/src/shell_policy.rs`
- Modify: `apps/agent/src/main.rs` (module declaration; `SessionConfig`; dispatcher arm at `:1011`; `resolve_shell_value` doc)
- Test: `apps/agent/src/shell_policy.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing (std only).
- Produces:
  - `pub struct ShellPolicy` (Clone) with `pub fn from_config(configured: &str) -> Self`, `pub fn new(candidates: impl IntoIterator<Item = PathBuf>) -> Self`, `pub fn resolve_client_shell(&self, requested: &str) -> anyhow::Result<PathBuf>`.
  - `SessionConfig.shell_policy: Arc<ShellPolicy>` — Task 6's E2E exercises it end to end.

- [ ] **Step 1: Write the failing unit tests**

Create `apps/agent/src/shell_policy.rs` with only the tests module (the implementation is Step 3):

```rust
//! The H1 shell allowlist: which executables a client-supplied
//! `terminal-create.shell` may name.

use std::collections::HashSet;
use std::path::PathBuf;

use anyhow::Result;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// A unique temp path per test. The caller removes it.
    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ponter-shell-policy-{}-{name}", std::process::id()))
    }

    /// Create an executable file at `path` (mode 0o755 on unix).
    fn write_executable(path: &Path) {
        std::fs::write(path, b"#!/bin/sh\n").expect("write temp shell");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn an_allowlisted_executable_is_resolved_to_its_canonical_path() {
        let file = temp_path("allowed");
        write_executable(&file);
        let policy = ShellPolicy::new(vec![file.clone()]);
        let resolved = policy.resolve_client_shell(file.to_str().unwrap()).unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&file).unwrap());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_path_outside_the_allowlist_is_refused() {
        let file = temp_path("outside");
        write_executable(&file);
        let policy = ShellPolicy::new(Vec::new());
        let err = policy.resolve_client_shell(file.to_str().unwrap()).unwrap_err();
        assert!(
            err.to_string().contains("not in the shell allowlist"),
            "{err}"
        );
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_relative_path_is_refused() {
        let policy = ShellPolicy::new(Vec::new());
        let err = policy.resolve_client_shell("sh").unwrap_err();
        assert!(err.to_string().contains("not an absolute path"), "{err}");
    }

    #[test]
    fn a_nonexistent_path_is_refused() {
        let policy = ShellPolicy::new(Vec::new());
        let missing = temp_path("missing");
        let err = policy
            .resolve_client_shell(missing.to_str().unwrap())
            .unwrap_err();
        assert!(err.to_string().contains("cannot be resolved"), "{err}");
    }

    #[test]
    fn a_directory_is_refused() {
        let dir = temp_path("dir");
        std::fs::create_dir_all(&dir).unwrap();
        let policy = ShellPolicy::new(vec![dir.clone()]);
        let err = policy.resolve_client_shell(dir.to_str().unwrap()).unwrap_err();
        assert!(err.to_string().contains("not a file"), "{err}");
        let _ = std::fs::remove_dir(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_non_executable_file_is_refused() {
        let file = temp_path("noexec");
        std::fs::write(&file, b"data").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        let policy = ShellPolicy::new(vec![file.clone()]);
        let err = policy.resolve_client_shell(file.to_str().unwrap()).unwrap_err();
        assert!(err.to_string().contains("not executable"), "{err}");
        let _ = std::fs::remove_file(&file);
    }

    #[cfg(unix)]
    #[test]
    fn two_paths_that_resolve_to_the_same_file_are_one_entry() {
        // `/bin/sh` is a symlink to the real shell on most unix hosts. Both
        // sides canonicalize, so either spelling is one allowlist entry —
        // comparing raw strings would wrongly refuse the second spelling.
        let real = std::fs::canonicalize("/bin/sh").expect("/bin/sh must exist on unix");
        let policy = ShellPolicy::new(vec![PathBuf::from("/bin/sh")]);
        assert_eq!(
            policy.resolve_client_shell(real.to_str().unwrap()).unwrap(),
            real
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_that_resolves_outside_the_allowlist_is_refused() {
        let allowed = temp_path("sym-allowed");
        write_executable(&allowed);
        let target = temp_path("sym-target");
        write_executable(&target);
        let link = temp_path("sym-link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap();

        // The allowlist holds `allowed`, not `target`; a request through the
        // symlink canonicalizes to `target` and must be refused.
        let policy = ShellPolicy::new(vec![allowed.clone()]);
        let err = policy.resolve_client_shell(link.to_str().unwrap()).unwrap_err();
        assert!(
            err.to_string().contains("not in the shell allowlist"),
            "{err}"
        );
        for p in [allowed, target, link] {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn the_configured_shell_is_always_allowed() {
        // current_exe() is absolute, exists, and (on unix) is executable —
        // the exact shape a configured shell must have. Using it keeps the
        // test hermetic: no dependence on the host's /etc/shells or $SHELL.
        let exe = std::fs::canonicalize(std::env::current_exe().expect("test binary path"))
            .expect("the test binary exists");
        let policy = ShellPolicy::from_config(exe.to_str().unwrap());
        assert_eq!(
            policy.resolve_client_shell(exe.to_str().unwrap()).unwrap(),
            exe
        );
    }

    #[cfg(unix)]
    #[test]
    fn etc_shells_entries_are_allowed_when_the_file_exists() {
        let Ok(text) = std::fs::read_to_string("/etc/shells") else {
            return; // a container without /etc/shells still has the floor
        };
        let Some(first) = text
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with('#') && std::path::Path::new(l).exists())
        else {
            return;
        };
        let policy = ShellPolicy::from_config("/bin/sh");
        assert!(
            policy.resolve_client_shell(first).is_ok(),
            "/etc/shells lists {first}, which the policy must accept"
        );
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/agent/Cargo.toml shell_policy`
Expected: FAIL to compile — `ShellPolicy` is not defined.

- [ ] **Step 3: Write the implementation**

Replace the file's top (above `#[cfg(test)]`) with:

```rust
//! The H1 shell allowlist: which executables a client-supplied
//! `terminal-create.shell` may name.
//!
//! `resolve_shell_value` returns any client string unmodified, and that string
//! is handed to `CommandBuilder::new` — arbitrary binary execution on the
//! agent host. This module closes that: a client value must canonicalize into
//! an allowlist of absolute paths. The configured `--shell` / `AGENT_SHELL` is
//! operator-trusted and always allowed — it is this agent's own deploy-time
//! policy, not client input.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// The minimal floor every unix host is expected to have. `/etc/shells` is the
/// admin-maintained list and normally covers these, but a hardened container
/// can ship without the file; the floor keeps a usable shell reachable.
#[cfg(unix)]
const UNIX_SHELL_FLOOR: [&str; 4] = ["/bin/sh", "/bin/bash", "/usr/bin/sh", "/usr/bin/bash"];

#[derive(Debug, Clone)]
pub struct ShellPolicy {
    allowed: HashSet<PathBuf>,
}

impl ShellPolicy {
    /// Build the policy from the operator-configured shell plus the platform
    /// floor and (on unix) `/etc/shells`.
    pub fn from_config(configured: &str) -> Self {
        let mut candidates: Vec<PathBuf> = vec![PathBuf::from(configured)];
        #[cfg(unix)]
        {
            candidates.extend(UNIX_SHELL_FLOOR.iter().map(PathBuf::from));
            candidates.extend(load_etc_shells());
        }
        Self::new(candidates)
    }

    /// Policy over an explicit candidate set — the seam the unit tests use so
    /// they never depend on the host's `/etc/shells`.
    ///
    /// Every candidate is canonicalized on the way in, so membership compares
    /// resolved paths on both sides: `/bin/sh` and `/usr/bin/dash` are one
    /// entry, not two. A candidate that does not canonicalize (missing file)
    /// is skipped — an allowlist entry that names nothing allows nothing.
    pub fn new(candidates: impl IntoIterator<Item = PathBuf>) -> Self {
        let allowed = candidates
            .into_iter()
            .filter_map(|p| std::fs::canonicalize(p).ok())
            .collect();
        Self { allowed }
    }

    /// Resolve a client-supplied shell, or refuse it with the reason.
    ///
    /// The caller turns a refusal into a `terminal-error` frame, so the
    /// browser sees a sentence rather than a silent blank terminal.
    pub fn resolve_client_shell(&self, requested: &str) -> Result<PathBuf> {
        let path = Path::new(requested);
        if !path.is_absolute() {
            bail!("{requested:?} is not an absolute path");
        }
        // canonicalize() fails for a nonexistent path — the not-exists case
        // falls out here rather than as a separate probe.
        let resolved = std::fs::canonicalize(path)
            .with_context(|| format!("{requested:?} cannot be resolved"))?;
        if !resolved.is_file() {
            bail!("{requested:?} is not a file");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&resolved)?.permissions().mode();
            if mode & 0o111 == 0 {
                bail!("{requested:?} is not executable");
            }
        }
        if !self.allowed.contains(&resolved) {
            bail!("{requested:?} is not in the shell allowlist");
        }
        Ok(resolved)
    }
}

/// Every non-comment, non-empty line of `/etc/shells`. A missing file is an
/// empty list, not an error: the floor still applies.
#[cfg(unix)]
fn load_etc_shells() -> Vec<PathBuf> {
    std::fs::read_to_string("/etc/shells")
        .map(|text| {
            text.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/agent/Cargo.toml shell_policy`
Expected: PASS (9 tests).

- [ ] **Step 5: Wire the policy into `SessionConfig` and the dispatcher**

In `apps/agent/src/main.rs`:

1. Declare the module beside the other `mod` lines (`rtc` then `shell_policy` then `signal`):

```rust
mod shell_policy;
```

2. Add the field to `SessionConfig` (after `pub shell: String,`):

```rust
    /// H1: the allowlist every client-supplied `terminal-create.shell` must
    /// canonicalize into. Built once per process from the configured shell
    /// plus the platform floor and `/etc/shells`.
    pub shell_policy: std::sync::Arc<shell_policy::ShellPolicy>,
```

3. In `run_with_reconnect`, where `cfg` is constructed, add beside `shell: shell.to_string(),`:

```rust
        shell_policy: std::sync::Arc::new(shell_policy::ShellPolicy::from_config(shell)),
```

4. In `run_one_session`, beside `let shell_for_dispatch = cfg.shell.clone();` (`main.rs:983`):

```rust
    let shell_policy_for_dispatch = std::sync::Arc::clone(&cfg.shell_policy);
```

5. Replace the dispatcher's shell resolution (`main.rs:1011`):

```rust
                    let sh = match create.shell {
                        // H1: a client-supplied shell is untrusted input; the
                        // configured shell (no client value) is operator policy.
                        Some(requested) => {
                            match shell_policy_for_dispatch.resolve_client_shell(&requested) {
                                Ok(path) => path.to_string_lossy().into_owned(),
                                Err(e) => {
                                    tracing::warn!(
                                        terminal_id = %create.terminal_id,
                                        requested = %requested,
                                        error = %e,
                                        "refused a client-supplied shell",
                                    );
                                    // Reuse the pinned spawn-failure frame: the
                                    // browser already surfaces its `message`, and a
                                    // third wire code would change a contract for no
                                    // reader's benefit.
                                    let frame = pty::frame_pty_error(
                                        &create.terminal_id,
                                        pty::PtyErrorCode::SpawnFailed,
                                        &format!("shell refused: {e}"),
                                        pty::now_ms(),
                                    );
                                    let _ = frame_tx_for_dispatch.send(frame).await;
                                    continue;
                                }
                            }
                        }
                        None => shell_for_dispatch.clone(),
                    };
```

6. Extend the `resolve_shell_value` doc comment (`main.rs:185`), after the "passed through to `CommandBuilder::new` unmodified" sentence:

```rust
/// **Only the configured value takes this path.** A client-supplied
/// `terminal-create.shell` never reaches `CommandBuilder` unvalidated: the
/// dispatcher resolves it through [`shell_policy::ShellPolicy`] first (H1).
```

- [ ] **Step 6: Run the full agent suite**

Run: `cargo test --manifest-path apps/agent/Cargo.toml && cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets -- -D warnings && cargo fmt --manifest-path apps/agent/Cargo.toml -- --check`
Expected: all green. The pre-existing `spawn_session` tests (`main.rs:2407`, shell `"x"`) still pass — the policy gate is at the dispatcher, not inside `spawn_session`.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(agent): add a shell allowlist for client-supplied terminal shells (H1)" -- apps/agent/src/shell_policy.rs apps/agent/src/main.rs
```

---

### Task 2: Do not activate a session on a refused answer (H2, server half)

**Files:**
- Modify: `apps/server/src/utils/signals.ts` (the `answer` branch of `recordSignal`)
- Modify: `apps/server/test/signaling.test.ts` (refactor the WS answer test onto a helper; add two refusal tests)
- Test: `apps/server/test/signaling.test.ts`

**Interfaces:**
- Consumes: `SignalMessage` from `@ponter/shared` (unchanged).
- Produces: `recordSignal` keeps its signature `(db, message) => Promise<SignalSelect | null>`; only the transition condition changes. The refusal answer is still inserted and still relayed.

- [ ] **Step 1: Write the failing tests**

In `apps/server/test/signaling.test.ts`, inside the outer `describe`, immediately before `describe('Signal routing via WebSocket', ...)`, add the helper:

```ts
  /**
   * Connect an agent socket, send one answer signal, and return the echoed
   * frame plus what the browser polls back. Shared by the approved and refused
   * answer tests so the socket lifecycle lives in one place.
   */
  async function agentAnswerRoundTrip(
    port: number,
    answer: { sdp: string; approved: boolean },
  ): Promise<{
    echoed: AgentSocketMessage | undefined;
    pollBody: {
      signals: Array<{ type: string; payload: Record<string, unknown> }>;
    };
  }> {
    const ws = new WebSocket(`ws://localhost:${port}/api/ws/agent`, {
      headers: { Authorization: `Bearer ${credential}` },
    });

    await waitFor(() => (ws.readyState === WebSocket.OPEN ? true : undefined));

    const received: string[] = [];
    ws.on('message', (data: Buffer) => {
      received.push(data.toString());
    });
    await wait(50);

    const answerMsg: AgentSocketMessage = {
      type: 'signal',
      data: {
        type: 'answer',
        data: { sessionId, ...answer },
      },
    };
    ws.send(JSON.stringify(answerMsg));

    const echoed = await waitFor(() => {
      const echo = received.find((m) => {
        try {
          const parsed = JSON.parse(m) as AgentSocketMessage;
          return parsed.type === 'signal' && parsed.data?.type === 'answer';
        } catch {
          return false;
        }
      });
      return echo ? (JSON.parse(echo) as AgentSocketMessage) : undefined;
    });

    const pollRes = await fetch(
      `http://localhost:${port}/api/signal/poll/${sessionId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const pollBody = (await pollRes.json()) as {
      signals: Array<{ type: string; payload: Record<string, unknown> }>;
    };

    ws.close();
    return { echoed, pollBody };
  }
```

Replace the existing `it('agent answer over WebSocket is recorded and browser can poll it', ...)` body with the helper call (assertions preserved verbatim):

```ts
    it('agent answer over WebSocket is recorded and browser can poll it', async () => {
      const { port, server: httpServer } = await startOnEphemeral();

      const { echoed, pollBody } = await agentAnswerRoundTrip(port, {
        sdp: 'v=0-o=answer',
        approved: true,
      });

      expect(echoed?.type).toBe('signal');
      expect(echoed?.data?.type).toBe('answer');
      expect(pollBody.signals).toHaveLength(1);
      expect(pollBody.signals[0]?.type).toBe('answer');

      httpServer.close();
    }, 10000);

    it('agent refusal over WebSocket is relayed but leaves the session pending', async () => {
      const { port, server: httpServer } = await startOnEphemeral();

      const { echoed, pollBody } = await agentAnswerRoundTrip(port, {
        sdp: 'v=0-o=refused',
        approved: false,
      });

      // The refusal is recorded and relayed — the browser's fast-fail reads
      // it (refused-answer.test.ts). What it must NOT do is activate.
      expect(echoed?.data?.type).toBe('answer');
      expect(pollBody.signals).toHaveLength(1);
      expect(pollBody.signals[0]?.payload.approved).toBe(false);

      const sess = await db
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get();
      expect(sess?.status).toBe('pending');

      httpServer.close();
    }, 10000);
```

In `describe('Signal routes', ...)`, after the existing approved-answer test, add:

```ts
    it('POST /api/signal/answer with approved:false records the refusal but leaves the session pending', async () => {
      const { app } = createSignalingServer();
      const res = await app.fetch(
        new Request('http://localhost/api/signal/answer', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            sessionId,
            sdp: 'v=0-o=refused',
            approved: false,
          }),
        }),
      );

      expect(res.status).toBe(201);

      const sess = await db
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get();
      expect(sess?.status).toBe('pending');

      // Relayed, not swallowed: the browser fast-fails on this row.
      const poll = await app.fetch(
        new Request(`http://localhost/api/signal/poll/${sessionId}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      const body = (await poll.json()) as {
        signals: Array<{ type: string; payload: { approved?: boolean } }>;
      };
      expect(
        body.signals.some(
          (s) => s.type === 'answer' && s.payload.approved === false,
        ),
      ).toBe(true);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/server test -- signaling.test.ts`
Expected: FAIL — both new tests see `status: 'active'` where they expect `'pending'`.

- [ ] **Step 3: Gate the transition**

In `apps/server/src/utils/signals.ts`, replace the transition block (and its comment) with:

```ts
  // `pending -> active` lives here rather than in either caller, because the
  // REST routes and the agent socket must not grow two copies of "insert the
  // signal, then maybe advance the session".
  //
  // H2: an answer with `approved === false` is a refusal (ADR-14) — a real
  // message the browser must read, so it is still inserted and relayed above.
  // What a refusal must not do is activate: the session stays `pending` so a
  // later, approved offer can still claim it.
  //
  // The guard is `= 'pending'`, NOT `IN ('pending','active')`. The transition's
  // guarantee is "when `type === 'answer'`, `approved !== false`, and the
  // session is `pending`".
  if (message.type === 'answer' && message.data.approved !== false) {
    await db
      .update(sessions)
      .set({ status: 'active', startedAt: NOW_SQL, updatedAt: NOW_SQL })
      .where(
        and(
          eq(sessions.id, message.data.sessionId),
          eq(sessions.status, 'pending'),
        ),
      );
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/server test -- signaling.test.ts`
Expected: PASS — including the pre-existing approved-answer test (the positive control).

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(server): do not activate a session on a refused answer (H2)" -- apps/server/src/utils/signals.ts apps/server/test/signaling.test.ts
```

---

### Task 3: Stop reconnecting on terminal close codes (M2)

**Files:**
- Modify: `apps/agent/src/signal.rs` (`run` signature, `Message::Close` arm, new `RunEnd` + `classify_close`, unit tests)
- Modify: `apps/agent/src/main.rs` (the `client.run` arm in `run_with_reconnect`, `main.rs:604`)
- Test: `apps/agent/src/signal.rs` (`mod tests`)

**Interfaces:**
- Consumes: `tokio_tungstenite::tungstenite::Message` (already imported); `CloseCode: Into<u16>`.
- Produces: `pub enum RunEnd { Terminal(u16), Transient }` (Debug, Clone, Copy, PartialEq, Eq); `pub fn classify_close(code: Option<u16>) -> RunEnd`; `SignalClient::run(&mut self, &mut mpsc::Receiver<SignalMessage>) -> Result<RunEnd>`. Task 4's E2E pins the `4409 → exit` behavior.

- [ ] **Step 1: Write the failing unit tests**

In `apps/agent/src/signal.rs`, inside `mod tests`, add:

```rust
    #[test]
    fn classify_close_treats_replaced_and_unauthorized_as_terminal() {
        // 4409: the server replaced this connection with a newer one for the
        // same agent id. Reconnecting would evict the newcomer, which would
        // reconnect in turn — a flap between two processes.
        assert_eq!(classify_close(Some(4409)), RunEnd::Terminal(4409));
        // 4401: the credential was rejected. Retrying can never succeed.
        assert_eq!(classify_close(Some(4401)), RunEnd::Terminal(4401));
    }

    #[test]
    fn classify_close_treats_everything_else_as_transient() {
        // 1001 is the server-restart close: terminal-ws.e2e.test.ts kills the
        // server under a live agent and requires it to reconnect. Treating
        // 1001 as terminal would strand that agent forever.
        assert_eq!(classify_close(Some(1001)), RunEnd::Transient);
        assert_eq!(classify_close(Some(1000)), RunEnd::Transient);
        assert_eq!(classify_close(Some(1011)), RunEnd::Transient);
        // No close frame at all (the stream just ended) is transient too.
        assert_eq!(classify_close(None), RunEnd::Transient);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/agent/Cargo.toml classify_close`
Expected: FAIL to compile — `classify_close` / `RunEnd` are not defined.

- [ ] **Step 3: Implement the classifier and thread it through `run`**

In `apps/agent/src/signal.rs`, add above `pub struct SignalClient` (or beside the backoff constants):

```rust
/// How the signaling socket ended, as far as the reconnect loop cares (M2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunEnd {
    /// The peer closed with a code that says "do not come back": 4409 (this
    /// agent was replaced by a newer connection) or 4401 (the credential was
    /// rejected). Reconnecting would flap against a server that has already
    /// decided, and in the 4409 case would evict the connection that replaced
    /// this one.
    Terminal(u16),
    /// Anything else — 1000, 1001, no close frame, or a read error: the socket
    /// died for a reason the next attempt can plausibly fix.
    Transient,
}

/// Classify a WebSocket close code for the reconnect loop.
///
/// Deliberately a pure function over `Option<u16>`: the close-code policy is
/// the part that can be unit-tested without a socket, and it is the part that
/// must not drift.
pub fn classify_close(code: Option<u16>) -> RunEnd {
    match code {
        Some(c @ (4409 | 4401)) => RunEnd::Terminal(c),
        _ => RunEnd::Transient,
    }
}
```

Change `run`'s signature and the two close-related returns:

```rust
    pub async fn run(&mut self, outbound_rx: &mut mpsc::Receiver<SignalMessage>) -> Result<RunEnd> {
```

```rust
                    let Some(frame) = frame else { return Ok(RunEnd::Transient) };  // stream ended without a close frame
```

```rust
                        Message::Close(frame) => {
                            // M2: the close code is the server's verdict. 4409
                            // (replaced) and 4401 (unauthorized) are terminal;
                            // everything else, including 1001 on a server
                            // restart, is a transient close the caller
                            // reconnects from.
                            let code = frame.map(|f| u16::from(f.code));
                            return Ok(classify_close(code));
                        }
```

Update `run`'s doc comment paragraph that says "a fatal condition; the supervisor in `main.rs` decides whether that is a reconnect or an exit" to:

```rust
    /// a fatal condition; the returned [`RunEnd`] carries the peer's verdict —
    /// the supervisor in `main.rs` reconnects only on [`RunEnd::Transient`].
```

- [ ] **Step 4: Handle the verdict in `run_with_reconnect`**

In `apps/agent/src/main.rs`, replace the `client.run` select arm (`main.rs:603-607`) and the comment above it:

```rust
                    // The socket ended. Whether that means "reconnect" is the
                    // socket's verdict, not a foregone conclusion (M2): 4409
                    // (replaced) and 4401 (unauthorized) stop the process;
                    // every other close — including the 1001 a server restart
                    // sends — reconnects with backoff. Nothing here touches
                    // the supervisor on the transient path: it lives in its
                    // own task across reconnects, so a live PeerConnection
                    // keeps being serviced while the socket is down.
                    result = client.run(&mut outbound_rx) => {
                        match result {
                            Ok(signal::RunEnd::Terminal(code)) => {
                                tracing::warn!(
                                    code,
                                    "the server closed this connection for good; not reconnecting"
                                );
                                supervisor.as_ref().expect("started").abort(); // ADR-12 teardown
                                return Ok(());
                            }
                            Ok(signal::RunEnd::Transient) => {}
                            Err(e) => {
                                tracing::warn!(error = %e, "signaling socket ended with an error");
                            }
                        }
                    }
```

- [ ] **Step 5: Run the agent suite**

Run: `cargo test --manifest-path apps/agent/Cargo.toml && cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets -- -D warnings && cargo fmt --manifest-path apps/agent/Cargo.toml -- --check`
Expected: all green (the two new classifier tests included).

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(agent): stop reconnecting on terminal close codes 4409/4401 (M2)" -- apps/agent/src/signal.rs apps/agent/src/main.rs
```

---

### Task 4: Eviction E2E — the replaced agent exits and stays exited (M2)

**Files:**
- Create: `packages/webrtc-core/test/e2e/session-hardening.e2e.test.ts`
- Test: same file

**Interfaces:**
- Consumes: `harness.ts` exports — `seed`, `spawnAgent`, `waitForAgentOnline`, `waitFor`, `agents`, `isLinux`, `setupE2E`, `teardownE2E`, `agentConnectCount`.
- Produces: the file Task 5 and Task 6 extend (same describe, same helpers).

- [ ] **Step 1: Write the failing E2E test**

Create `packages/webrtc-core/test/e2e/session-hardening.e2e.test.ts`:

```ts
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isLinux,
  setupE2E,
  teardownE2E,
  seed,
  spawnAgent,
  waitForAgentOnline,
  waitFor,
  agents,
} from './harness';

/**
 * Layer 3, WS3: session-hardening regressions that need the real binary and
 * the real server. Each test here pins one audit finding — M2 (close-code
 * handling), M3 (foreign-candidate rejection), H1 (shell allowlist) — through
 * a path that a unit test cannot reach (the webrtc 0.21 `PeerConnection`
 * trait is sealed, and the shell gate's refusal must travel over a real data
 * channel).
 *
 * Linux-only (the Rust binary must be built for the host).
 */
describe.skipIf(!isLinux)('cross-language WS3 session hardening', () => {
  beforeAll(async () => {
    await setupE2E();
  }, 120_000);

  afterAll(async () => {
    await teardownE2E();
  }, 60_000);

  /**
   * M2, the eviction half: the server evicts the previous socket with 4409
   * when a second connection registers the same agent id. Before the fix the
   * old agent treated that as transient and reconnected — which evicted the
   * *newcomer* in turn, a flap between two processes. The old agent must exit
   * instead, and stay exited: the connect count must not grow again.
   */
  it('exits instead of reconnecting when the server replaces it (4409)', async () => {
    const { token, agentId, credential } = await seed();

    const first = spawnAgent(agentId, credential);
    await waitForAgentOnline(token, agentId);

    // A second process with the same id and credential. The server closes the
    // first socket with 4409 ('Replaced by new connection').
    spawnAgent(agentId, credential);

    await waitFor(
      () => first.child.exitCode !== null || first.child.signalCode !== null,
      'the first agent to exit after being replaced',
      20_000,
    );

    // The regression this test exists for: a flapping agent reconnects after
    // the eviction. Give it a generous window (the backoff ladder is
    // 200ms..2s) and require the count to hold still.
    const afterEviction = agentConnectCount(first.output);
    await delay(4_000);
    expect(
      agentConnectCount(first.output),
      `the replaced agent reconnected — its output:\n${first.output()}`,
    ).toBe(afterEviction);

    // The log line names the verdict so a failure of THIS test is diagnosable
    // from the output alone.
    expect(first.output()).toMatch(/not reconnecting/i);
  }, 60_000);
});
```

- [ ] **Step 2: Mutation proof — prove the test is load-bearing**

Task 3 already landed, so this test passes on first run. Prove it would have caught the bug: temporarily revert the `Message::Close` arm in `apps/agent/src/signal.rs` to the pre-fix `return Ok(())` and change the `main.rs` arm's `Ok(signal::RunEnd::Terminal(_))` branch to fall through like `Transient` (a two-line edit), rebuild, re-run:

```bash
cargo build --locked --manifest-path apps/agent/Cargo.toml
pnpm --filter @ponter/webrtc-core test:e2e -- session-hardening -t "replaces it"
```

Expected: **FAIL** — the first agent reconnects after eviction and the connect count grows. Record the failure output in the task report. Then restore both files exactly (`git diff apps/agent/src` must be empty), rebuild, re-run:

```bash
cargo build --locked --manifest-path apps/agent/Cargo.toml
pnpm --filter @ponter/webrtc-core test:e2e -- session-hardening -t "replaces it"
```

Expected: PASS again.

- [ ] **Step 3: Verify the whole file is green**

Run: `pnpm --filter @ponter/webrtc-core test:e2e -- session-hardening`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "test(e2e): pin that a replaced agent (4409) exits instead of flapping (M2)" -- packages/webrtc-core/test/e2e/session-hardening.e2e.test.ts
```

---

### Task 5: Foreign-candidate rejection regression + mutation proof (M3)

**Files:**
- Modify: `packages/webrtc-core/test/e2e/session-hardening.e2e.test.ts`
- Modify (only for the mutation proof, reverted immediately): `apps/agent/src/main.rs:2027-2034`

**Interfaces:**
- Consumes: `seedSignedTerminal`, `connectTerminal`, `sendKeystrokes`, `waitForTerminalOutput`, `waitFor`, `agents`, `postJson`, `frameBytes` from `harness.ts`; the agent's debug log line `"dropping a candidate for a session that is not live"` (`main.rs:2030`).
- Produces: the regression that pins the `route_inbound` guard, with recorded red/green evidence.

- [ ] **Step 1: Write the regression test**

Extend `session-hardening.e2e.test.ts` — add these imports to the existing import block:

```ts
import {
  postJson,
  seedSignedTerminal,
  connectTerminal,
  sendKeystrokes,
  waitForTerminalOutput,
} from './harness';
```

Add the test inside the describe:

```ts
  /**
   * M3: a candidate addressed to a session this agent is not running must be
   * dropped by the live session's router, not applied to its peer connection.
   *
   * The guard landed in 5ef6bd5 (before the spec's baseline) but had no test —
   * this is that test, and Step 3 proves it is load-bearing by mutation.
   *
   * The debug log is the observable: the live session logs the drop with both
   * ids. A candidate is delivered through the REST route for session B while
   * session A is live; the server pushes it to the same agent socket, the live
   * session's `route_inbound` sees `candidate.session_id != session_id` and
   * drops it. Session A must stay healthy across the event.
   */
  it('drops a candidate for a foreign session while a session is live (M3)', async () => {
    const { token, agentId, sessionId, identity, agent } =
      await seedSignedTerminal({ env: { RUST_LOG: 'debug' } });

    const { offerer, frames } = await connectTerminal(sessionId, token, identity);

    try {
      sendKeystrokes(offerer, sessionId, 'echo before-foreign-candidate\n');
      await waitForTerminalOutput(frames, 'before-foreign-candidate');

      // A second session for the same agent: a legitimate row the agent will
      // never serve (ADR-14), used only as a foreign session id.
      const foreign = await postJson<{ id: string }>(
        '/api/sessions',
        { agentId },
        token,
      );

      await postJson<{ id: string }>(
        '/api/signal/ice-candidate',
        {
          sessionId: foreign.id,
          candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
        token,
      );

      await waitFor(
        () =>
          agent
            .output()
            .includes('dropping a candidate for a session that is not live'),
        'the live session to log the foreign-candidate drop',
        10_000,
      );

      // The live session must be unaffected by the dropped candidate.
      sendKeystrokes(offerer, sessionId, 'echo after-foreign-candidate\n');
      await waitForTerminalOutput(frames, 'after-foreign-candidate');
    } finally {
      await offerer.close();
    }
  }, 90_000);
```

- [ ] **Step 2: Run it to verify it passes on the current tree**

Run: `pnpm --filter @ponter/webrtc-core test:e2e -- session-hardening`
Expected: PASS.

- [ ] **Step 3: Mutation proof — prove the test is load-bearing**

Temporarily delete the guard in `apps/agent/src/main.rs` (the `if candidate.session_id != session_id { ... return Ok(()); }` block at `:2027-2034`), rebuild, and re-run only this test:

```bash
cargo build --locked --manifest-path apps/agent/Cargo.toml
pnpm --filter @ponter/webrtc-core test:e2e -- session-hardening -t "foreign session"
```

Expected: **FAIL** — the drop log line never appears (the candidate is applied instead). Record the failure output in the task report.

Then restore the guard exactly (`git diff apps/agent/src/main.rs` must be empty afterwards), rebuild, re-run:

```bash
cargo build --locked --manifest-path apps/agent/Cargo.toml
pnpm --filter @ponter/webrtc-core test:e2e -- session-hardening -t "foreign session"
```

Expected: PASS again, `git status` clean for `main.rs`.

- [ ] **Step 4: Commit**

```bash
git commit -m "test(e2e): pin foreign-candidate rejection with a mutation-proven guard (M3)" -- packages/webrtc-core/test/e2e/session-hardening.e2e.test.ts
```

---

### Task 6: Shell allowlist E2E — allowed shell works, disallowed shell refused (H1)

**Files:**
- Modify: `packages/webrtc-core/test/e2e/session-hardening.e2e.test.ts`
- Test: same file

**Interfaces:**
- Consumes: `sendTerminalCreate` (5th parameter `shell`), `waitFor`, `agents`, `seedSignedTerminal`, `connectTerminal`, `sendKeystrokes`, `waitForTerminalOutput`, `frameBytes`.
- Produces: the end-to-end proof of Task 1's policy: a refused shell travels as a `terminal-error` frame with `code: 'pty-spawn-failed'`, and no PTY output ever follows for that terminal id.

- [ ] **Step 1: Write the failing tests**

Extend `session-hardening.e2e.test.ts` — add `sendTerminalCreate` to the harness imports, and add inside the describe:

```ts
  /**
   * H1, the allowed half: an explicitly allowlisted shell still spawns, so the
   * policy did not break the feature it hardens. `/bin/sh` is in the floor on
   * every unix host.
   */
  it('spawns a terminal for an allowlisted client-supplied shell', async () => {
    const { token, sessionId, identity } = await seedSignedTerminal();

    const { offerer, frames } = await connectTerminal(sessionId, token, identity);

    try {
      const terminalId = `term-allowed-${sessionId}`;
      sendTerminalCreate(offerer, terminalId, 80, 24, '/bin/sh');
      await delay(500);

      sendKeystrokes(offerer, terminalId, 'echo allowlist-ok\n');
      await waitForTerminalOutput(frames, 'allowlist-ok');
    } finally {
      await offerer.close();
    }
  }, 90_000);

  /**
   * H1, the refused half: a client-supplied shell outside the allowlist must
   * be refused with a `terminal-error` frame (code `pty-spawn-failed`, the
   * pinned contract) and no PTY may ever run for that terminal id.
   *
   * `sleep` is chosen because it exists, is executable, and is categorically
   * not a shell: if the gate ever regresses, the spawned process would run
   * and the test would catch bytes on the channel.
   */
  it('refuses a client-supplied shell outside the allowlist (H1)', async () => {
    const { token, sessionId, identity, agent } = await seedSignedTerminal();

    const { offerer, frames } = await connectTerminal(sessionId, token, identity);

    try {
      const terminalId = `term-refused-${sessionId}`;
      sendTerminalCreate(offerer, terminalId, 80, 24, '/bin/sleep');

      // The refusal must be visible on the channel, not only in the log.
      const deadline = Date.now() + 15_000;
      let refusal: { code?: string; message?: string } | undefined;
      while (Date.now() < deadline && !refusal) {
        refusal = frames.find(
          (f) =>
            f.type === 'terminal-error' &&
            (f.payload as { terminalId?: string }).terminalId === terminalId,
        )?.payload as { code?: string; message?: string } | undefined;
        if (!refusal) await delay(100);
      }

      expect(
        refusal,
        `no terminal-error frame for ${terminalId}\n--- agent output ---\n${agent.output()}`,
      ).toBeDefined();
      expect(refusal?.code).toBe('pty-spawn-failed');
      expect(refusal?.message).toMatch(/refused/i);

      // No PTY ran: a shell would have produced output; `sleep` produces
      // nothing, so the strong assertion is the log — no spawn line for this
      // terminal id — plus no data frames carrying this terminalId (the
      // refusal frame itself is a `terminal-error`, not data).
      expect(agent.output()).toMatch(/refused a client-supplied shell/);
      expect(
        frames.filter(
          (f) =>
            f.type === 'terminal-data' && f.payload.terminalId === terminalId,
        ),
      ).toHaveLength(0);
    } finally {
      await offerer.close();
    }
  }, 90_000);
```

- [ ] **Step 2: Mutation proof — prove the refusal test is load-bearing**

Temporarily revert Task 1's dispatcher gate in `apps/agent/src/main.rs` (put back `let sh = create.shell.unwrap_or_else(|| shell_for_dispatch.clone());`), rebuild, and run only the refusal test:

```bash
cargo build --locked --manifest-path apps/agent/Cargo.toml
pnpm --filter @ponter/webrtc-core test:e2e -- session-hardening -t "outside the allowlist"
```

Expected: **FAIL** — with no gate, `/bin/sleep` spawns and no `terminal-error` frame ever arrives (the frame wait times out). Record the failure output in the task report. Then restore the gate exactly (`git diff apps/agent/src` must be empty), rebuild, re-run:

```bash
cargo build --locked --manifest-path apps/agent/Cargo.toml
pnpm --filter @ponter/webrtc-core test:e2e -- session-hardening -t "outside the allowlist"
```

Expected: PASS again.

- [ ] **Step 3: Run to verify the whole file passes**

Run: `pnpm --filter @ponter/webrtc-core test:e2e -- session-hardening`
Expected: PASS (4 tests in the file).

- [ ] **Step 4: Commit**

```bash
git commit -m "test(e2e): pin the shell allowlist — allowed shell spawns, /bin/sleep refused (H1)" -- packages/webrtc-core/test/e2e/session-hardening.e2e.test.ts
```

---

### Task 7: Docs — WS3 security note, guide correction, spec erratum

**Files:**
- Create: `docs/security/2026-10-06-ws3-session-hardening.md`
- Modify: `docs/guides/handshake-connection-flow.md:155`
- Modify: `docs/superpowers/specs/2026-10-05-phase5-zero-trust-e2ee-design.md` (§2 table, H2 and M3 rows)
- Test: none (documentation), verified by the BA audit step of the review chain.

**Interfaces:**
- Consumes: nothing.
- Produces: the written record Task 8's Verification cites for G2/G5.

- [ ] **Step 1: Write the WS3 security note**

Create `docs/security/2026-10-06-ws3-session-hardening.md`:

```markdown
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
   fast) since commit `5ef6bd5` (2026-10-01), which predates this workstream.

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
   `5ef6bd5` (2026-10-01) and is present at the spec baseline `680cccc0` — the
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
```

- [ ] **Step 2: Correct the handshake guide**

In `docs/guides/handshake-connection-flow.md`, replace the sentence (line 155):

```
`approved` is the agent's capability gate: `true` when the offer's `capabilities` contained `"terminal"` (`rtc.rs:153`). The server stores it verbatim (`recordSignal` passes `message.data` through); **nothing enforces `approved === false` server-side today** — a refusal is visible only in the flag.
```

with:

```
`approved` is the agent's capability gate: `true` when the offer's `capabilities` contained `"terminal"` (`rtc.rs:153`), and `false` for an ADR-14 refusal. Since Week 14 (WS3) the server enforces it: `recordSignal` only transitions a session `pending → active` when `approved !== false`, and the browser refuses a refusal answer before `setRemoteDescription` (`connection.ts`). The refusal is still recorded and relayed — enforcement gates the transition, not the message.
```

- [ ] **Step 3: Record the spec erratum**

In `docs/superpowers/specs/2026-10-05-phase5-zero-trust-e2ee-design.md` §2, update the two stale rows:

```markdown
| H2 | Session `approved` recorded but never enforced | **CONFIRMED** (server) / **STALE** (client) | server: `recordSignal` activated on any answer — fixed in WS3 (Week 14). client: `connection.ts` has refused `approved: false` since `5ef6bd5` (2026-10-01), before this spec's baseline |
| M3 | `candidate.session_id` not validated against the active offer | **STALE** | the guard landed in `5ef6bd5` (2026-10-01), before this spec's baseline `680cccc0`; WS3 (Week 14) added the missing regression test and mutation proof |
```

- [ ] **Step 4: Commit**

```bash
git commit -m "docs(security): WS3 session-hardening note, guide correction, spec erratum" -- docs/security/2026-10-06-ws3-session-hardening.md docs/guides/handshake-connection-flow.md docs/superpowers/specs/2026-10-05-phase5-zero-trust-e2ee-design.md
```

---

## Verification

Run these on the frozen branch tip before the review chain. Every command must be green.

- [ ] **Typecheck / lint / format (all workspaces)**

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm format:check
```

> `format:check` is **mandatory** here (Week 12 carry-forward: a plan §Verification that omits it shipped a red CI). It runs `prettier --check .` from the root. `apps/web/src/components/ui/` stays in `.prettierignore` — do not add generated files back.

- [ ] **Node tests (server + shared + webrtc-core + terminal-core + web)**

```bash
pnpm --filter @ponter/shared test
pnpm --filter @ponter/crypto test
pnpm --filter @ponter/server test
pnpm --filter @ponter/web test
pnpm --filter @ponter/webrtc-core test
```

- [ ] **Rust agent tests**

```bash
cargo test --manifest-path apps/agent/Cargo.toml
cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path apps/agent/Cargo.toml -- --check
```

- [ ] **Cross-language E2E (Linux) — the new file AND the pre-existing suites**

```bash
cargo build --locked --manifest-path apps/agent/Cargo.toml
pnpm --filter @ponter/webrtc-core test:e2e
```

> The whole suite, not only `session-hardening`: the two load-bearing regressions this week must stay green — `terminal-ws.e2e.test.ts` ("reconnects its signaling socket and delivers signals after a server restart" — the M2 transient-close guard) and `terminal.e2e.test.ts` ("refuses a second concurrent session with a fast, visible failure" — the H2/ADR-14 refusal path).

- [ ] **Negative-control spot checks (must fail closed)**

```bash
# 1. `sendTerminalCreate(offerer, id, 80, 24, '/bin/sleep')` → terminal-error
#    (pty-spawn-failed), no PTY. (Automated in Task 6; spot-check by hand once.)
# 2. POST /api/signal/answer with approved:false → session stays pending,
#    the answer row is still pollable. (Automated in Task 2.)
# 3. Kill the server under a live agent → the agent reconnects (1001 is
#    transient). (Automated in terminal-ws.e2e.test.ts.)
# 4. Register a second agent with the same id → the first exits, no flap.
#    (Automated in Task 4.)
```

- [ ] **Spec exit-gate check (partial — G1/G2 only; G3–G5 land in WS1/WS5)**

- G1 (partial): H1, H2, M2, M3 each closed with the test named in its task; the spec §2 erratum recorded (Task 7).
- G2: no UI or docs text claims a protection WS3 does not implement; `docs/guides/handshake-connection-flow.md:155` no longer says "nothing enforces `approved === false` server-side today".

- [ ] **Sonar check on the PR**

The SonarQube quality gate must pass on new code (Week 13 gotcha: test-file duplication counts — Task 2 parameterizes the answer round-trip into one helper for exactly this reason; do not reintroduce a copy).

## Self-review notes (author)

- **Spec coverage:** §3.3 bullet 1 (shell allowlist) → Tasks 1, 6; bullet 2 (enforce `approved` in server and client) → Task 2 (server half) + existing `connection.ts`/`refused-answer.test.ts` (client half, already shipped — recorded in Task 7); bullet 3 (close-code handling) → Tasks 3, 4; bullet 4 (validate `candidate.session_id`) → Task 5 (regression + mutation proof — the guard itself already shipped in `5ef6bd5`).
- **Stale-spec discovery recorded, not re-implemented:** the M3 guard and the client half of H2 predate the spec baseline `680cccc0` (commit `5ef6bd5`, 2026-10-01 23:20, ancestor of both `680cccc0` and `main`). The plan corrects the §2 table (Task 7) instead of duplicating work — this is the one place the plan deviates from the spec text, and it deviates toward *less* code, with the evidence recorded.
- **Boundary guards:** no task implements E2EE (WS1); ADR-29 stays closed (`--allow-input` untouched); no wire-contract change (`pty-spawn-failed` reused, `TerminalCreateMessage` unchanged); no new dependency (Rust std only; no npm package).
- **Type consistency:** `ShellPolicy` (`from_config` / `new` / `resolve_client_shell` → `Result<PathBuf>`) is defined in Task 1 and consumed only at the dispatcher arm; `RunEnd` / `classify_close` are defined in Task 3 and consumed in `run_with_reconnect` in the same task; the E2E file created in Task 4 is extended, not duplicated, by Tasks 5–6.
- **Load-bearing proofs:** every behavioral fix has a mutation proof (Tasks 4, 5, 6) — the guard is removed, the test is observed red, the guard is restored, the test is observed green. This is the Week 13 lesson ("workflow verdict = INPUT not binding") applied to tests: a green test that cannot go red proves nothing.
- **Known limitation, flagged:** the shell allowlist constrains the *executable*, not its arguments or environment; a client that names an allowlisted shell still gets that shell's full power. That is the documented boundary of H1 (spec §3.3 says "allowlist of absolute paths per platform, validated against the filesystem") and the reason ADR-29's input gate stays closed.
- **Open item for the owner:** design decisions 1 (allowlist model: configured shell + floor + `/etc/shells`) and 4 (M2 stop semantics: only 4409/4401 terminal, everything else reconnects) are the two places the spec is silent on mechanism; both are presented above for sign-off before execution.

## Execution handoff

Execution method: **Subagent-driven** (the standing pattern for this project — owner chose it for Week 13, and this plan's tasks have an explicit dependency chain: Task 1 → Task 6, Task 3 → Task 4, Task 4 → Tasks 5/6 share one E2E file). Each task goes to a fresh implementer; the task reviewer, QA verification on the frozen tip, BA docs audit, PM cross-check, and owner merge decision follow the project's mandatory multi-step review chain.


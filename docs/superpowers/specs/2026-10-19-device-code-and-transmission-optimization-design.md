# 9-Digit Device Code & Video Transmission Optimization — Design Spec

- **Status:** Draft (ready for team review)
- **Phases:** Phase 15 (Device Code Identity & Issue #152) and Phase 16 (Transmission Optimization & 60 FPS Roadmap)
- **Date:** 2026-10-19
- **Supersedes / Amends:** Extends the device identity model established in Phase 7 / PR #155 (`localAgentId` + keychain credential) and the streaming profiles established in Phase 3 / ADR-21, ADR-23, ADR-24. Amends the error taxonomy in `packages/api-client` (Issue #152).
- **Related ADRs:** ADR-13 (agent credentials), ADR-14 (single active session per agent), ADR-21 (resolved stream profile), ADR-22 (source switching), ADR-23 (runtime bitrate retarget), ADR-24 (sustain fallback floor), ADR-41 (admission gate), ADR-47 (frame timing telemetry), ADR-48 (WebCodecs probe — FAIL/DESCOPED), ADR-52 (keychain isolation), ADR-64/65 (config resolution and persistence), ADR-82 (fleet push), ADR-85 (Electron desktop shell), ADR-86 (agent sidecar supervision), ADR-89 (unified API access), **ADR-91 (9-digit Device Code identity — proposed by this spec)**, **ADR-92 (frame-budget-driven transmission profiles and zero-copy GPU roadmap — proposed by this spec)**
- **Related Files:** `apps/server/src/db/schema.ts`, `apps/server/src/db/client.ts`, `apps/server/src/utils/agent.ts`, `apps/server/src/routes/agents.ts`, `apps/server/src/routes/sessions.ts`, `packages/shared/src/types/user.ts`, `packages/api-client/src/errors.ts`, `packages/api-client/test/client.test.ts`, `apps/desktop/src/shared/ipc-types.ts`, `apps/desktop/src/main/devices.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/renderer/views/DevicesView.vue`, `apps/desktop/src/renderer/stores/devices.ts`, `apps/web/src/views/DashboardView.vue`, `apps/web/src/views/WorkspaceView.vue`, `apps/web/src/stores/terminal.ts`, `apps/agent/src/lib.rs`, `apps/agent/src/main.rs`, `apps/agent/src/desktop.rs`

---

## 1. Context & Motivation

### 1.1 Device identity is machine-shaped, not human-shaped

Every agent row is keyed by a caller-supplied identifier of the form `dev_xxxxxxxx`, generated in `apps/desktop/src/main/devices.ts` as:

```ts
const deviceId = `dev_${crypto.randomUUID().slice(0, 8)}`;
```

That string is a good primary key and a poor human handle. It contains a prefix, an underscore, and eight hex characters drawn from a 16-symbol alphabet — a user reading it over a phone call, a chat message, or a support ticket has to spell it out character by character and will confuse `0`/`o`, `1`/`l`, and `b`/`6`. Every mainstream remote-desktop product (RustDesk, AnyDesk, TeamViewer) instead issues a short numeric identifier that is grouped for readability and read aloud in three chunks.

The project owner has approved replacing the user-facing identifier with a **9-digit Device Code** formatted `XXX XXX XXX`, while keeping `agents.id` exactly as it is. The code is an **alias**, not a replacement key: the internal primary key, the credential binding (`device_credential_${id}`), the `AGENT_ID` environment variable passed to the sidecar, the session foreign key, and every WebSocket routing path continue to use `agents.id`. This keeps the change additive and 100% backward compatible.

### 1.2 Issue #152 — a reachable 5xx is reported as unreachable

`packages/api-client/src/errors.ts` classifies any response whose body is not JSON as `NETWORK_ERROR`:

```ts
} catch {
  return new ApiError(
    response.statusText || `HTTP ${response.status}`,
    response.status,
    'NETWORK_ERROR',
    null,
  );
}
```

A reverse proxy, Cloudflare error page, or gateway timeout that answers `502`/`504` with an HTML or plaintext body is therefore indistinguishable from a transport failure. `apps/desktop/src/main/session.ts` then maps that code onto a message that actively misleads the user:

```ts
if (err?.status === 0 || err?.code === 'NETWORK_ERROR') {
  throw loginError(`Cannot reach ${this.apiClient.http.baseUrl} (network error)`, 'NETWORK_ERROR');
}
```

The server *did* answer. The fix is a one-branch taxonomy correction: a non-JSON body on a 5xx status is a `SERVER_ERROR`; a non-JSON body on a 4xx status is an `API_ERROR`; only a rejected `fetch` (no HTTP response at all) remains `NETWORK_ERROR` with `status: 0`.

### 1.3 30 FPS is a frame-budget choice, not a protocol limit

The desktop stream currently ticks at `profile.frame_budget()` — `1 / 30 = 33.33 ms` — and encodes with openh264 at `Complexity::Low`, `ScreenContentRealTime`, `RateControlMode::Bitrate`. The H.264 payload is transport-agnostic: nothing in the WebRTC path or in the browser's decoder requires 30 FPS. Moving to 60 FPS halves the frame budget to `16.67 ms` and roughly doubles the per-second CPU cost of capture, downscale, colour conversion, and encode.

The two engineering questions are therefore:

1. **Can the existing SIMD CPU pipeline sustain a 16.67 ms budget on representative hardware, and what is the safe degradation ladder when it cannot?** (Stage 1)
2. **What architecture removes the CPU copy chain entirely, so the budget stops being the constraint?** (Stage 2 — a roadmap, not a shipped deliverable)

The measurement history in this repository bounds the answer. The top local lever — vectorised downscaling via `fast_image_resize` — was already merged in PR #144 with a measured ~6.2x improvement, and the static-content measurement showed openh264 already realises ~99.8% of the bit savings on an unchanged screen (9351 B static vs 4,988,352 B moving at a 4 Mbps target). Static-frame skipping therefore buys **CPU headroom**, not bandwidth. Hardware H.264/HEVC/AV1 encode is **not available on the development host** (VP9 and JPEG only), H.265 is not offered by current Chrome, and AV1 is a conditional opt-in. Stage 2 must be specified as a probe-and-fallback architecture whose tiers are selected at runtime, never assumed.

---

## 2. Locked Owner Decisions

The following requirements have been approved by the owner and are binding.

### Part A — Phase 15: Device Code & Issue #152

1. **Human-readable identity.** The user-facing device identifier becomes a 9-digit numeric code in the range `100 000 000` – `999 999 999`, rendered as `XXX XXX XXX`.
2. **Additive schema.** `agents` gains a nullable `device_code TEXT` column with a unique index. `agents.id` is unchanged and remains the primary key.
3. **Allocation and backfill.** The server allocates a collision-free 9-digit code on registration and backfills every pre-existing agent row that has no code.
4. **Shared contract.** `Agent` in `packages/shared/src/types/user.ts` gains `deviceCode: string | null`.
5. **Dual resolution.** Session creation accepts a device code or a legacy `agentId`; codes are normalised by stripping spaces and dashes before lookup. Legacy `dev_...` identifiers keep working with no client change.
6. **Desktop UI.** "This Device" displays the code in bold monospace `XXX XXX XXX` with one-click copy. The "Remote Control" partner input auto-groups digits into `XXX XXX XXX` as the user types and still accepts a pasted `dev_...` identifier.
7. **Web UI.** The device list displays the Device Code alongside the machine hostname.
8. **Issue #152.** A non-JSON 5xx response is classified as `SERVER_ERROR`, not `NETWORK_ERROR`.

### Part B — Phase 16: Transmission Optimization & 60 FPS

9. **Frame budget is the design unit.** `16.67 ms` (60 FPS) versus `33.33 ms` (30 FPS) is the number every stage is measured against.
10. **Stage 1 — 60 FPS on the existing SIMD CPU pipeline.** Add `1080p60` (8–10 Mbps) and `720p60` (5–6 Mbps) stream profiles, drive the ticker from `frame_budget()`, skip re-encoding unchanged frames, and degrade through a profile ladder when the host cannot sustain the budget. `720p30` remains the guaranteed floor.
11. **Stage 2 — zero-copy GPU pipeline roadmap.** Specify a GPU probe (NVENC / QuickSync / AMF / VAAPI) and a direct VRAM path (DXGI or PipeWire texture → GPU compute shader → hardware encoder → RTP packetizer) with an explicit, safe fallback hierarchy.

---

## 3. Part A — Device Code Architecture (Phase 15 / ADR-91)

### 3.1 Data model and migration

#### 3.1.1 Drizzle schema

`apps/server/src/db/schema.ts`, inside `export const agents = sqliteTable('agents', { ... })`, add after `credentialHash`:

```ts
deviceCode: text('device_code'),
```

The column is nullable at the schema level. Uniqueness is enforced by a dedicated unique index (created below), not by a `.unique()` modifier, so that the same DDL is valid both for a fresh database and for an `ALTER TABLE` on an existing one.

#### 3.1.2 Migration surface — the real one

This repository does **not** use a generated Drizzle migration folder. `apps/server/src/db/client.ts` defines `runMigrations(sqlite: BetterSqlite3.Database)`, which executes one `CREATE TABLE IF NOT EXISTS ...` script and then a series of idempotent `try { sqlite.exec('ALTER TABLE ...') } catch {}` blocks. Any implementation that adds a `drizzle/` migrations directory will not run in this codebase. The change must land in `runMigrations` in three places:

**(a) The fresh-database DDL.** Add the column to the `CREATE TABLE IF NOT EXISTS agents (...)` body, immediately after `credential_hash TEXT UNIQUE,`:

```sql
device_code TEXT,
```

**(b) The idempotent upgrade block**, appended after the existing `signing_public_key` block:

```ts
// Phase 15: human-facing 9-digit device code (ADR-91). Nullable so the
// ALTER is a no-op on a table that already has it; the unique index below
// is created separately because SQLite rejects ADD COLUMN ... UNIQUE.
try {
  sqlite.exec(`ALTER TABLE agents ADD COLUMN device_code TEXT;`);
} catch {}
try {
  sqlite.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_device_code ON agents(device_code);`,
  );
} catch {}
```

**(c) The backfill call**, executed once after the schema work and before the server starts accepting traffic:

```ts
backfillDeviceCodes(sqlite);
```

`backfillDeviceCodes` is a new exported function in `apps/server/src/utils/agent.ts` (or a sibling module) with these properties:

- Selects `id` for every row where `device_code IS NULL`.
- Allocates a code per row using the same allocator as registration, inserting with a per-row `UPDATE ... WHERE id = ?` and relying on the unique index to reject a collision; a collision retries with a fresh code.
- Is **idempotent**: a second run finds zero NULL rows and does nothing.
- Is **bounded**: a hostile or corrupted database cannot spin forever — a bounded retry per row, and a hard failure (logged, server start aborts) if the allocator cannot place a code after the bound.
- Emits one `tracing`/log line with the number of rows backfilled.

Because the server is a single Node.js process against a single SQLite file, no cross-process allocation race exists. The unique index is still the correctness boundary, not the pre-check.

### 3.2 The 9-digit allocator

`generateDeviceCode()` returns a `string` of exactly nine digits, first digit non-zero:

```ts
const MIN_DEVICE_CODE = 100_000_000;
const MAX_DEVICE_CODE = 999_999_999;
const DEVICE_CODE_SPACE = MAX_DEVICE_CODE - MIN_DEVICE_CODE + 1; // 900_000_000
```

Generation must use **rejection sampling**, not a modulo reduction, so that every code in the range is equally likely:

```ts
export function generateDeviceCode(): string {
  const buf = new Uint32Array(1);
  // Reject the top partial bucket so the modulo below is unbiased.
  const limit = Math.floor(0x1_0000_0000 / DEVICE_CODE_SPACE) * DEVICE_CODE_SPACE;
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return String(MIN_DEVICE_CODE + (buf[0] % DEVICE_CODE_SPACE));
}
```

Allocation on registration is a bounded attempt loop around the unique index:

```ts
async function allocateDeviceCode(db: AppDatabase): Promise<string> {
  for (let attempt = 0; attempt < DEVICE_CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidate = generateDeviceCode();
    const clash = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.deviceCode, candidate))
      .get();
    if (!clash) return candidate;
  }
  throw new AppError('Failed to allocate a device code', 500, 'INTERNAL_SERVER_ERROR');
}
```

`DEVICE_CODE_ALLOCATION_ATTEMPTS = 10`. The probability of ten consecutive collisions is negligible even at scale: the birthday bound for the 900-million space is roughly 30,000 agents before a 50% chance of *some* pair colliding, so collisions are expected in production but individual retries are cheap and independent. The pre-check is an optimisation; the unique index is the guarantee, and the insert must still be wrapped so that a `SQLITE_CONSTRAINT_UNIQUE` on `device_code` retries rather than surfacing as a 500.

### 3.3 Shared contract

`packages/shared/src/types/user.ts`, `interface Agent`, gains one field after `signingPublicKey`:

```ts
/** Human-facing 9-digit device code (`XXX XXX XXX`), or null before allocation. */
deviceCode: string | null;
```

Two downstream projections must be updated in the same change, or the field will silently disappear at a layer boundary:

1. **`toPublicAgent()` in `apps/server/src/utils/agent.ts`.** This function is an explicit literal projection and a documented security boundary (it must never spread the row, because the row carries `credentialHash`). Add:
   ```ts
   deviceCode: agent.deviceCode ?? null,
   ```
2. **`DesktopDevice` in `apps/desktop/src/shared/ipc-types.ts`** and **`mapAgentToDesktopDevice()` in `apps/desktop/src/main/devices.ts`.** The Electron main process re-projects `Agent` onto its own IPC contract; without the field here, the renderer can never render a code.
   ```ts
   deviceCode: string | null;
   ```

Formatting is a pure helper, exported from `packages/shared` so the desktop renderer, the web app, and the server can all use one definition:

```ts
/** `749281903` -> `749 281 903`; a null/empty value -> the em dash placeholder. */
export function formatDeviceCode(code: string | null | undefined): string;
/** `"749 281 903"` / `"749-281-903"` -> `"749281903"`; non-numeric input is returned trimmed. */
export function normalizeDeviceCode(raw: string): string;
```

`normalizeDeviceCode` strips **only** spaces and dashes (`/[\s-]/g`). It must not strip other characters, because a legacy `dev_ab12cd34` identifier has to survive normalisation unchanged.

### 3.4 API resolution — dual lookup, canonical result

#### 3.4.1 `POST /api/sessions`

`resolveOwnedId()` in `apps/server/src/routes/sessions.ts` currently trims the input, calls a lookup, and returns **the trimmed candidate**:

```ts
const candidate = typeof raw === 'string' ? raw.trim() : '';
if (!candidate) throw new AppError(notFoundMessage, 404, 'NOT_FOUND');
const found = await lookup(candidate);
if (!found) throw new AppError(notFoundMessage, 404, 'NOT_FOUND');
return candidate;
```

That contract is wrong for device codes: the session row's `agent_id` column is a foreign key to `agents.id`, so storing `"749281903"` there would write a dangling reference. The resolver must return the **canonical** identifier of the row it found.

The minimal correct change is to make the lookup return the row and the resolver read a canonical key from it:

```ts
async function resolveOwnedId<T extends { id: string }>(
  raw: unknown,
  lookup: (candidate: string, normalized: string) => Promise<T | undefined>,
  notFoundMessage: string,
): Promise<string | null> {
  if (raw === undefined || raw === null) return null;
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (!candidate) throw new AppError(notFoundMessage, 404, 'NOT_FOUND');
  const normalized = normalizeDeviceCode(candidate);
  const found = await lookup(candidate, normalized);
  if (!found) throw new AppError(notFoundMessage, 404, 'NOT_FOUND');
  return found.id;
}
```

The agent call site becomes a single ownership-scoped query matching either identity:

```ts
const agentId = await resolveOwnedId(
  body.agentId,
  (candidate, normalized) =>
    db
      .select()
      .from(agents)
      .where(
        and(
          or(eq(agents.id, candidate), eq(agents.deviceCode, normalized)),
          eq(agents.userId, user.id),
        ),
      )
      .get(),
  'Agent not found',
);
```

The device call site passes `candidate` through unchanged for both parameters (devices have no device code).

Behavioural requirements:

- **Tenancy first.** The `userId` predicate stays inside the same query as the identity match. A code belonging to another user must produce the same `404 Agent not found` as a code that does not exist — no oracle.
- **Normalisation is input-side only.** `"749 281 903"`, `"749-281-903"`, `" 749281903 "`, and `"749281903"` all resolve to the same row.
- **Legacy path unchanged.** `"dev_ab12cd34"` normalises to itself and matches `agents.id`.
- **Ambiguity is impossible by construction.** `device_code` is nine digits with a non-zero leading digit; `agents.id` is `dev_` plus eight hex characters. The two sets cannot intersect, so an `OR` is unambiguous.

#### 3.4.2 `GET /api/agents/:id` — a required companion change

The web workspace does **not** call `sessions.create` alone. `apps/web/src/stores/terminal.ts` resolves peer identity and E2EE context through:

```ts
const agent = await apiClient.agents.get(agentId);   // lines ~201 and ~240
```

`GET /api/agents/:id` matches `agents.id` only. If a user opens `${serverUrl}/workspace/749281903`, `sessions.create` would succeed (after 3.4.1) while `agents.get("749281903")` returns 404 and the connection fails during identity resolution. The device-code flow is therefore **incomplete** unless `GET /api/agents/:id` applies the same normalised dual lookup, scoped to the caller's tenancy.

The same treatment should be applied to the read-only `PATCH`/`DELETE` lookups **only if** they are reachable from a device-code surface. The desktop and web fleet tables always hold canonical `id` values, so the minimum required surface is `GET`. Implementers must not widen the surface speculatively.

### 3.5 Desktop UI (`apps/desktop/src/renderer/views/DevicesView.vue`)

#### 3.5.1 "This Device"

Replace the raw-identifier `<code>` block with a device-code block. The existing `data-testid="this-device-id"` is retained as an alias so that any test keyed on it keeps resolving, and a new `data-testid="this-device-code"` names the new surface.

```vue
<div class="flex items-center gap-2">
  <code
    data-testid="this-device-code"
    class="font-mono text-lg font-bold tracking-wider select-all"
    >{{ formatDeviceCode(localDevice?.deviceCode) }}</code
  >
  <Button
    v-if="localDevice?.deviceCode"
    data-testid="copy-device-code"
    variant="ghost"
    size="xs"
    class="shrink-0"
    @click="copyDeviceCode(localDevice.deviceCode)"
  >
    <Check v-if="copiedId" class="w-3.5 h-3.5 text-emerald-500" />
    <Copy v-else class="w-3.5 h-3.5" />
  </Button>
</div>
```

Rules:

- `localDevice` is resolved from `store.devices.find((d) => d.id === localAgentId)`; `deviceCode` comes from the shared `Agent` contract, not from a locally derived value.
- The clipboard write uses the **digits only** (`749281903`), not the spaced form, so a paste into any other surface works without a second normalisation step. The visual grouping is presentation only.
- When `deviceCode` is `null` (a row that has not yet been backfilled, or an offline fetch), the surface renders the em-dash placeholder and the copy button is disabled. It must never fall back to displaying `dev_...` as if it were a device code.
- The 2-second `Check` confirmation and the existing `copiedId` timer are reused; no second timer is introduced.

#### 3.5.2 "Remote Control"

The partner input keeps `data-testid="remote-agent-id-input"` and `v-model="remoteAgentId"`, but gains an input handler that groups digits while typing:

```ts
/** Digits only, grouped in threes, capped at nine digits. */
function formatPartnerInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 9);
  if (!digits) return raw.trim();          // legacy `dev_...` pasted verbatim
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ');
}
```

Rules:

- Typing `749281903` renders `749 281 903`; the caret must stay usable (append-only editing is sufficient for the first implementation; a caret-preserving implementation is preferred but not required).
- Pasting `dev_ab12cd34` must leave the value intact — the handler detects that the input contains non-digit characters and returns it trimmed rather than destroying it.
- Pasting `749-281-903` normalises to `749 281 903`.
- The Connect button's enabled predicate is `remoteAgentId.trim().length > 0`; it must not require exactly nine digits, because legacy identifiers remain valid.
- `handleRemoteConnect()` passes the raw field value to `window.ponter.openRemoteSession()`; normalisation happens once, in the IPC handler (below), so the renderer cannot drift from the main process.

#### 3.5.3 IPC channel 21 normalisation

`desktop:open-remote-session` in `apps/desktop/src/main/ipc.ts` currently validates only that `payload.agentId` is a non-empty trimmed string, then URL-encodes it into `${basePath}/workspace/${encodeURIComponent(rawAgentId)}`. A spaced code would therefore reach the web app as `749%20281%20903`, and — after decoding — as a route parameter containing spaces.

The handler must normalise before building the URL:

```ts
const rawAgentId = normalizeDeviceCode(payload.agentId.trim());
```

using the same shared helper as the server. Consequences:

- `"749 281 903"` becomes `749281903` in the URL path.
- `"dev_ab12cd34"` is unchanged (normalisation strips only spaces and dashes).
- The existing protocol assertion (`http:` / `https:` only), subpath preservation, and `shell.openExternal` delegation are unchanged.

Because the normalised value is digits-only for the new path, it needs no further character allow-list; the legacy path keeps the current behaviour of URL-encoding.

### 3.6 Web UI

#### 3.6.1 Device list (`apps/web/src/views/DashboardView.vue`)

The agent card currently renders:

```vue
<span>ID:</span>
<span class="text-foreground/80">{{ a.id }}</span>
```

Change to render the device code as the primary identity and keep the canonical id as secondary metadata:

- Primary line: `Device Code: 749 281 903` in monospace, using `formatDeviceCode(a.deviceCode)`, with a copy control.
- Secondary line: the canonical `a.id` in a muted, smaller font, retained because the workspace route and every existing deep link still use it.
- The search filter (currently `a.id.toLowerCase().includes(query)`) must also match the normalised device code, so a support engineer can search by the code a user read aloud.
- The `Launch Shell` action continues to route with `a.id` — never with the code — so existing routes, E2EE identity resolution, and session rows are unaffected.

#### 3.6.2 Workspace entry by code

`WorkspaceView.vue` reads `route.params.agentId` and calls `terminalStore.openTab(initialAgentId)`. With the companion change in §3.4.2, a code in the URL resolves correctly through `sessions.create` and `agents.get`. No client-side rewriting is required, and none should be added: keeping the code opaque in the URL preserves the single normalisation point on the server.

### 3.7 Issue #152 — error classification

`ApiError.fromResponse()` keeps the JSON path exactly as it is. Only the `catch` branch changes:

```ts
} catch {
  const isServerError = response.status >= 500 && response.status < 600;
  return new ApiError(
    response.statusText || `HTTP ${response.status}`,
    response.status,
    isServerError ? 'SERVER_ERROR' : 'API_ERROR',
    null,
  );
}
```

Classification table:

| Condition | Code | Status |
|---|---|---|
| JSON body with `code` | `data.code` | HTTP status |
| JSON body without `code` | `API_ERROR` | HTTP status |
| Non-JSON body, status 500–599 | `SERVER_ERROR` | HTTP status |
| Non-JSON body, status 400–499 | `API_ERROR` | HTTP status |
| `fetch` rejects (no response) | `NETWORK_ERROR` | `0` |

The transport-level throw in `packages/api-client/src/client.ts` (`new ApiError(msg, 0, 'NETWORK_ERROR')`) is already correct and must not change: it is the only path where the server genuinely did not answer.

Downstream effect: `apps/desktop/src/main/session.ts` maps only `status === 0` or `code === 'NETWORK_ERROR'` onto "Cannot reach …". A 502 with an HTML body now surfaces the server's own `statusText` (`Bad Gateway`) instead.

**TEST-INTEGRITY declaration.** `packages/api-client/test/client.test.ts` contains an assertion that pins the old behaviour:

```ts
it('4. Throws ApiError with code: NETWORK_ERROR when response body is not JSON', ...)
```

Its expected `code` changes from `NETWORK_ERROR` to `SERVER_ERROR` (status `502` and message `Bad Gateway` unchanged), and the test title changes accordingly. This is a **declared behaviour change**, not a weakened test: the `it()` count is unchanged, the `expect()` count is unchanged, and the new expectation is strictly more specific about the intended taxonomy. The implementation plan must record the before→after pair verbatim.

---

## 4. Part B — Transmission Optimization (Phase 16 / ADR-92)

### 4.1 Frame budget

| Target | Period | Per-frame budget | Frames per 1 s |
|---|---|---|---|
| 30 FPS | 33.33 ms | `33_333_333 ns` | 30 |
| 60 FPS | 16.67 ms | `16_666_666 ns` | 60 |

`StreamProfile::frame_budget()` already computes `Duration::from_secs_f32(1.0 / self.fps)`, and `run_stream` already builds its ticker from it:

```rust
let mut ticker = tokio::time::interval(profile.frame_budget());
ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
```

**There is no separate ticker constant to change.** A 60 FPS profile produces a 16.67 ms ticker automatically. The requirement "ticker interval 16.67 ms in `desktop.rs`" is satisfied by selecting a 60 FPS profile; introducing a second, hard-coded interval would create two sources of truth and is prohibited.

`MissedTickBehavior::Delay` means a tick that overruns does not produce a burst of catch-up ticks; the stream simply falls behind in real time. This is the correct behaviour for a live stream and must be preserved.

The end-to-end budget per tick is:

```
capture acquisition + downscale + crop_to_even + RGBA→YUV420 + H.264 encode + sample write
        <= 16.67 ms (60 FPS)
```

If any stage overruns, the sustain ladder (§4.4) reacts. The measurement seam is already in place: `timing_ring.record(frame.seq, capture_epoch_ms, encode_ms, capture_ms)` feeds `desktop-stats` with `captureMsP50` and `encodeMsP50` (ADR-47), which is how the ladder's decisions become observable rather than inferred.

### 4.2 Stage 1 — profiles, encoder, and capture cadence

#### 4.2.1 `StreamProfile` additions (`apps/agent/src/lib.rs`)

```rust
/// 1080p60 at 8 Mbps: the Stage 1 default for hosts with CPU headroom.
pub const P1080P60: Self = Self {
    max_width: 1920,
    max_height: 1080,
    fps: 60.0,
    bitrate_bps: 8_000_000,
};

/// 720p60 at 5 Mbps: the first rung below 1080p60.
pub const P720P60: Self = Self {
    max_width: 1280,
    max_height: 720,
    fps: 60.0,
    bitrate_bps: 5_000_000,
};
```

The owner-approved ranges are 8–10 Mbps for `1080p60` and 5–6 Mbps for `720p60`. The constants take the **lower** bound because `RateControlMode::Bitrate` with `Complexity::Low` overshoots on scene changes, and the runtime retarget path (`desktop-bitrate`, ADR-23) already allows the browser to raise the target within `MIN_BITRATE_BPS..=MAX_BITRATE_BPS` (250 kbps – 20 Mbps). Starting low and raising on demand is the safer default.

`FromStr` gains both names and the error message lists all four:

```rust
match value {
    "1080p60" => Ok(Self::P1080P60),
    "720p60"  => Ok(Self::P720P60),
    "1080p30" => Ok(Self::DEFAULT_1080P30),
    "720p30"  => Ok(Self::SAFE_720P30),
    other => bail!(
        "unknown desktop profile {other:?}; expected 1080p60, 720p60, 1080p30 or 720p30"
    ),
}
```

`apps/agent/src/main.rs` documents `--desktop-profile` / `AGENT_DESKTOP_PROFILE`; its doc comment must name the new values. The default stays `1080p30` in this phase: 60 FPS is opt-in until the sustain ladder and the capture cadence have been validated on real hardware.

#### 4.2.2 Encoder configuration (`DesktopEncoder::new`)

`max_frame_rate` and `bitrate` already derive from the profile. One field is hard-coded and becomes wrong at 60 FPS:

```rust
.intra_frame_period(IntraFramePeriod::from_num_frames(60))
```

At 30 FPS that is a 2-second GOP; at 60 FPS it silently becomes 1 second, doubling IDR cost and bitrate spikes. Scale it to a fixed **time** window:

```rust
let gop_frames = (profile.fps * 2.0).round().max(1.0) as u32;
// ...
.intra_frame_period(IntraFramePeriod::from_num_frames(gop_frames))
```

`UsageType::ScreenContentRealTime`, `RateControlMode::Bitrate`, `Complexity::Low`, `adaptive_quantization(false)`, `background_detection(false)`, and `VuiConfig::bt709()` are unchanged — each is deliberate (the two disabled flags silence an openh264 `ParamValidation` warning, as documented in the source comment).

#### 4.2.3 Capture cadence — the 33 ms ceiling

The `capture_image` polling fallback (Windows, last resort) sleeps a fixed interval:

```rust
const GDI_DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(33);
```

A 33 ms capture period **cannot** feed a 16.67 ms ticker — the ticker would find no new frame on every second tick, and the effective rate would stay at 30 FPS regardless of the profile. The poll interval must therefore be derived from the profile's frame budget, with `AGENT_DESKTOP_POLL_INTERVAL_MS` still overriding for diagnostics:

```rust
fn gdi_poll_interval(profile: StreamProfile) -> Duration {
    std::env::var("AGENT_DESKTOP_POLL_INTERVAL_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(profile.frame_budget())
}
```

`parse_poll_interval` keeps its existing unit tests; a new test asserts that the profile-derived default is 16 ms at 60 FPS and 33 ms at 30 FPS. This path is CPU-bound by construction and is the first candidate for the Stage 2 probe to retire.

#### 4.2.4 Static-frame skip

Goal: spend **no CPU** on downscale + colour conversion + encode when the captured surface is unchanged. The measurement record is explicit that this buys CPU, not bandwidth — openh264 already emits ~9 KB for a static 1080p frame at a 4 Mbps target versus ~5 MB for a moving one.

Design:

1. **Cheap signature first.** Hash a sparse sample of the raw RGBA buffer (for example, every 64th pixel plus a rolling FNV-1a over the full buffer only when the sparse sample matches). A full-buffer hash on every frame would itself consume a meaningful fraction of a 16.67 ms budget.
2. **Skip on match.** When the signature equals the previous *encoded* frame's signature, do not downscale and do not call `encoder.encode()`. Increment `skipped` and continue.
3. **Keepalive cap.** Never skip more than `MAX_STATIC_SKIP` consecutive frames (design value: `fps` frames, i.e. one second). After the cap, encode one frame unconditionally so the receiver's jitter buffer and any PLI-driven recovery path always see periodic media.
4. **Invalidate on control events.** A `SourceSwap`, a bitrate retarget, or a profile downgrade resets the stored signature; the next frame is always encoded.
5. **Do not count skipped ticks as encoded frames.** `encoded` drives the periodic `desktop-stats` emission (`encoded % fps_period == 0`); a static screen must still report stats. Emit a stats frame at most once per second while skipping, using the last known `encoded_size`.

Interaction with the cursor: the cursor overlay is drawn client-side by `DesktopView.vue` (canvas + `requestAnimationFrame`), and cursor position travels on the data channel, not in the video. A screen whose only change is the remote cursor therefore legitimately produces identical frames — the overlay still moves. This is the desired behaviour, and it is why the skip cannot be keyed on "did the user move the mouse".

#### 4.2.5 Client playout — an honest scope

The owner decision names WebCodecs `VideoDecoder` synchronised to `requestAnimationFrame`. That must be recorded accurately against the existing evidence:

- **ADR-48 probed WebCodecs and returned FAIL / DESCOPED.** openh264 emits Annex-B; `VideoDecoder.configure({ codec: 'avc1.42E01F' })` requires an AVCC-formatted `description` (SPS/PPS out of band), so a decoder integration needs an Annex-B → AVCC conversion layer plus parameter-set extraction before it can be attempted.
- **The current playout path already renders at display refresh.** `DesktopView.vue` binds a `MediaStream` to `<video autoplay>`; the browser's compositor presents decoded frames at the monitor's refresh rate (60/120/144 Hz). The cursor overlay already runs on `requestAnimationFrame`. There is no 30 Hz presentation limit on the client.
- **The 30 FPS ceiling is entirely on the sender**, in `run_stream`'s ticker.

Therefore Stage 1's client work is **tuning, not re-architecture**:

| Option | Cost | Decision |
|---|---|---|
| Keep `<video>`; lower `playoutDelayMs` from 100 ms toward 0–40 ms on LAN | One constant in `apps/web/src/stores/terminal.ts` | **Ship in Stage 1** |
| Keep `<video>`; raise `jitterBufferTarget` on WAN | Configuration only | Ship, per network profile |
| WebCodecs `VideoDecoder` + rAF presentation | Annex-B→AVCC conversion, parameter-set cache, decoder lifecycle, ADR-48 reversal | **Gated follow-up**, only if measured presentation jitter remains after Stage 1 |

`packages/desktop-core/src/client.ts` already writes `receiver.jitterBufferTarget` (Chrome) or `receiver.playoutDelayHint` (Firefox) from `playoutDelayMs`, so the Stage 1 change is a value, not a mechanism. Any WebCodecs work requires a new ADR that explicitly supersedes ADR-48's verdict and states the AVCC prerequisite.

### 4.3 Stage 2 — zero-copy GPU hardware pipeline (roadmap)

Stage 2 is a **specified architecture with a probe**, not a committed implementation. Its purpose is to make the 16.67 ms budget irrelevant by removing the CPU copy chain.

#### 4.3.1 Current chain (CPU)

```
OS capture (xcap) -> RGBA buffer in system memory
  -> downscale (fast_image_resize, SIMD)
  -> crop_to_even
  -> RGBA -> YUV420 conversion
  -> openh264 software encode (Annex-B)
  -> RTP packetization
```

Every arrow is a copy or a transform on the CPU. At 1080p60 this chain must complete in 16.67 ms including capture.

#### 4.3.2 Target chain (zero-copy)

```
OS capture surface (DXGI Desktop Duplication texture / PipeWire DMA-BUF)
  -> GPU texture (no CPU readback)
  -> GPU compute shader (scale + RGBA -> NV12)
  -> hardware encoder (NVENC / QuickSync / AMF / VAAPI)
  -> encoded bitstream in GPU-visible memory
  -> RTP packetization
```

The CPU's remaining work is control-plane only: querying the capture surface, submitting command buffers, and writing RTP headers. The design target is 0–1% CPU for the media path.

#### 4.3.3 GPU probe

A startup probe selects the best available tier. It must be **observational and non-fatal**: a missing driver, a headless session, or a container without device access degrades to the next tier rather than failing startup.

| Tier | Platform | Probe | Encode API |
|---|---|---|---|
| NVENC | Windows / Linux, NVIDIA | Enumerate encode-capable devices; attempt a 1-frame 1080p encode | NVENC |
| QuickSync | Windows / Linux, Intel | Media Foundation / VAAPI `VAEntrypointEncSlice` | MF Transform / VA-API |
| AMF | Windows, AMD | Enumerate AMF encoders | AMF |
| VAAPI generic | Linux | `vaQueryConfigProfiles` for H.264 | VA-API |
| CPU SIMD | All | Always available | openh264 |

Probe results are reported through the existing stats/telemetry channel, so a support report states which tier was selected and why the others were rejected. The probe must run **once** per agent process, not per session, and its result is cached.

#### 4.3.4 Fallback hierarchy

```
GPU Zero-Copy  ->  CPU SIMD Software  ->  GDI Polling
```

Rules:

- **Downgrade is automatic and one-way within a session.** A hardware encoder that fails mid-stream (device lost, driver reset) tears down the current encoder and rebuilds on the next tier; it does not retry the failed tier in the same session.
- **Upgrade requires a new session.** No mid-session promotion, because a codec/format change forces a renegotiation.
- **Every tier reports the same `StreamProfile` contract**, so `desktop-stats`, the bitrate retarget path, and the sustain ladder behave identically regardless of tier.
- **The floor is `720p30` on the CPU SIMD tier.** GDI polling is the last resort and is documented as CPU-bound and unable to sustain high frame rates; it exists so a machine streams *something* rather than nothing.

#### 4.3.5 Known constraints that shape Stage 2

- The development host exposes **no H.264/HEVC/AV1 hardware encode profile** (VP9 and JPEG only), so Stage 2 cannot be validated locally; it requires a machine with a hardware encoder.
- **H.265 remains blocked by the browser** (current Chrome does not offer `video/H265`), even though `rtc` 0.21 registers HEVC payload type 126 and AV1 payload type 41.
- **AV1 is a conditional opt-in**, not a default: Chrome can send and receive it, but measured cost is roughly 2.3x CPU and 4.5x wall-clock on this pipeline.
- **PLI / keyframe-on-demand is a missing path.** Any hardware-encoder integration must add an explicit IDR request path; without it, a decoder that loses sync waits for the GOP boundary.

---

## 5. Security & Isolation Considerations

1. **The Device Code is an identifier, not a credential.** It grants nothing on its own. Authorization remains: authenticated session → ownership predicate (`agents.userId = user.id`) → ADR-41 admission gate → WS2 peer identity → E2EE. A code is never used as a bearer token, never embedded in a URL that bypasses authentication, and never stored in place of the agent credential.
2. **No enumeration oracle.** A code that exists but belongs to another user, and a code that does not exist, both produce the identical `404 Agent not found`. Lookup is always scoped by `userId` inside the same query as the identity match.
3. **No public resolution endpoint.** There is deliberately no `GET /api/device-codes/:code` or similar. Adding one would convert a 9-digit space into an enumerable directory of online machines.
4. **Credential isolation is unchanged (ADR-13 / ADR-52 / R8).** The agent credential remains `ag_` + 32 hex, stored only in the OS keychain under `device_credential_${agents.id}` and passed to the sidecar through `AGENT_CREDENTIAL`. The Device Code never enters `config.json`, renderer storage, or the sidecar environment.
5. **The projection boundary holds.** `toPublicAgent()` remains an explicit literal; the new field is added to it by hand. The row is never spread, so `credentialHash` cannot leak alongside `deviceCode`.
6. **Logging.** Device codes are safe to log (they are not secrets), but logs must record the canonical `agents.id` for correlation. A support workflow should be able to go from a code in a user report to the agent row without a second lookup surface.
7. **Error taxonomy (Issue #152) does not weaken transport security.** Only the classification label changes; no response body is rendered as HTML, and the message still comes from `statusText`, not from an untrusted payload.

---

## 6. Testing & Verification Strategy

### 6.1 Server — device code (`apps/server/test/agents-sessions.test.ts` and a new `device-code.test.ts`)

- Allocator emits exactly nine digits, first digit non-zero, within `[100_000_000, 999_999_999]`, over a large sample.
- Allocator distribution is not visibly skewed (a coarse bucket test over a large sample; a strict statistical test is out of scope).
- Registration persists a non-null `device_code` and returns it inside `toPublicAgent`.
- Two concurrent registrations never share a code (unique index enforced).
- `POST /api/sessions` resolves `"749 281 903"`, `"749-281-903"`, `" 749281903 "`, and `"749281903"` to the same canonical `agents.id`, and the stored `sessions.agent_id` is that canonical id.
- Legacy `dev_xxxxxxxx` continues to resolve with no normalisation change.
- A code owned by another user yields `404 NOT_FOUND` with the same message as a non-existent code.
- `GET /api/agents/:id` resolves a device code to the canonical agent for the owner, and 404s for a non-owner.
- Backfill assigns codes to every pre-existing NULL row, is idempotent on a second run, and does not touch rows that already have one.

### 6.2 API client — Issue #152 (`packages/api-client/test/client.test.ts`)

- Non-JSON `502` → `SERVER_ERROR`, status `502`, message from `statusText`.
- Non-JSON `404` → `API_ERROR`, status `404`.
- JSON error body with `code` → unchanged (`data.code`).
- JSON error body without `code` → `API_ERROR`.
- Rejected `fetch` → `NETWORK_ERROR`, status `0` (unchanged).
- **Declared change:** the existing non-JSON test's expected `code` moves from `NETWORK_ERROR` to `SERVER_ERROR`; `it()` and `expect()` counts are unchanged.

### 6.3 Desktop (`apps/desktop/src/renderer/__tests__/devices.test.ts`, `apps/desktop/src/main/__tests__/devices.test.ts`, `apps/desktop/src/main/__tests__/ipc.test.ts`)

- "This Device" renders `749 281 903` when the local device carries `deviceCode: "749281903"`.
- Copy writes digits only (`749281903`) to the clipboard and shows the confirmation icon.
- A `null` `deviceCode` renders the placeholder and disables the copy control.
- Partner input groups digits while typing and caps at nine.
- Partner input preserves a pasted `dev_ab12cd34` verbatim.
- `desktop:open-remote-session` normalises `"749 281 903"` to `749281903` in the constructed URL, and leaves `dev_ab12cd34` unchanged.
- `mapAgentToDesktopDevice` propagates `deviceCode`, including `null`.

### 6.4 Web (`apps/web/src/__tests__/`)

- The dashboard renders a device-code line for an agent with a code and the placeholder for one without.
- The search filter matches a query against the device code with and without spaces.
- `Launch Shell` still routes with the canonical `a.id`.
- `WorkspaceView` with a device-code route parameter opens a tab and reaches `sessions.create` with that value.

### 6.5 Agent (`cargo test -p ponter_agent`)

- `"1080p60"` and `"720p60"` parse; `frame_budget()` is `16_666_666 ns` (asserted as `as_millis() == 16` plus a nanosecond-level assertion).
- `"720p30"` still parses and still yields a 33.33 ms budget.
- An unknown profile string fails with an error naming all four accepted values.
- GOP frames equal `round(fps * 2)` for 30 and 60 FPS.
- Poll interval defaults to `frame_budget()` when the environment variable is absent, and the environment variable still wins when present.
- Static-frame detection returns "unchanged" for an identical buffer and "changed" for a one-pixel mutation.
- The skip counter honours the keepalive cap and resets on a control event.
- The sustain ladder descends `1080p60 → 720p60 → 1080p30 → 720p30` and latches at the floor.
- No test deletes, skips, or weakens an existing assertion (TEST-INTEGRITY).

### 6.6 Repo-wide gates

| Gate | Command | Pass criteria |
|---|---|---|
| Format | `pnpm format:check` | Exit 0 |
| Typecheck | `pnpm typecheck` | Exit 0 |
| Server | `pnpm --filter @ponter/server test -- --run` | 100% green |
| API client | `pnpm --filter @ponter/api-client test -- --run` | 100% green |
| Desktop | `pnpm --filter @ponter/desktop test -- --run` | 100% green |
| Web | `pnpm --filter @ponter/web test -- --run` | 100% green |
| Agent | `cargo test -p ponter_agent` | 100% green |
| Attribution | `git log` audit | Single author line, zero `Co-authored-by` trailers |
| Language | Character scan | Zero Vietnamese characters in code, tests, docs, commits |

---

## 7. Backward Compatibility & Parity Ledger

| Existing behaviour | This spec | Migration impact |
|---|---|---|
| `agents.id` = `dev_` + 8 hex, caller-supplied | Unchanged; remains the primary key, the keychain key suffix, the `AGENT_ID` value, and the session foreign key | None |
| User-facing identifier is `dev_xxxxxxxx` | 9-digit `XXX XXX XXX` Device Code displayed in desktop and web | Additive; the old identifier still works everywhere |
| `Agent` contract has no device code | `deviceCode` added as `string` or `null` | Additive field; existing consumers ignore it |
| Session creation accepts `agentId` only | Accepts a device code or a legacy `agentId`, returns the canonical id | 100% backward compatible |
| `GET /api/agents/:id` matches `agents.id` only | Also matches a normalised device code, ownership-scoped | Additive |
| `POST /api/agents` returns `{ agent, credential }` | Same shape, `agent.deviceCode` populated | Additive |
| Non-JSON 5xx → `NETWORK_ERROR` | Non-JSON 5xx → `SERVER_ERROR`; non-JSON 4xx → `API_ERROR` | Declared behaviour change; one test expectation updated |
| Desktop "This Device" shows `dev_...` | Shows the formatted code; the canonical id remains available in the fleet table | Presentation change |
| Partner input accepts free text | Auto-groups digits, still accepts `dev_...` | Additive |
| Stream profiles `1080p30` / `720p30` | Adds `1080p60` / `720p60`; default stays `1080p30` | Additive |
| Ticker = `profile.frame_budget()` | Unchanged mechanism; 60 FPS profiles yield 16.67 ms automatically | None |
| GOP = 60 frames (2 s at 30 FPS) | GOP = `round(fps * 2)` frames (2 s at any rate) | Behaviour preserved at 30 FPS, corrected at 60 FPS |
| GDI poll interval 33 ms | Derived from `frame_budget()`; env override preserved | Enables 60 FPS on the fallback path |
| Sustain fallback = `SAFE_720P30` | Ladder `1080p60 → 720p60 → 1080p30 → 720p30`, latched at the floor | Supersedes ADR-24's single-rung rule; the floor is unchanged |
| Client playout = `<video>` + 100 ms | `<video>` retained; `playoutDelayMs` lowered for LAN; WebCodecs gated behind a new ADR | ADR-48 verdict preserved |

---

## 8. Acceptance Criteria

### Part A

1. A newly registered agent receives a unique 9-digit code and it appears in the registration response.
2. A pre-existing agent row without a code receives one at startup, exactly once.
3. Entering `749 281 903`, `749-281-903`, or `749281903` in the desktop partner field connects to the same machine.
4. Entering a legacy `dev_xxxxxxxx` still connects.
5. The desktop "This Device" card shows `XXX XXX XXX` with a working one-click copy.
6. The web dashboard shows the code for each device and can search by it.
7. A `502` HTML response surfaces as a server error, not "Cannot reach".
8. `pnpm format:check`, all four JS/TS test suites, and `cargo test -p ponter_agent` are green.
9. Zero test deletions or weakenings; every changed expectation is declared before→after.

### Part B

1. `--desktop-profile 1080p60` and `--desktop-profile 720p60` start a session whose `desktop-stats` reports `fps: 60`.
2. The ticker period observed in `desktop-stats` timing is ~16.67 ms on a host that sustains the budget.
3. A host that cannot sustain 16.67 ms descends the ladder and reports each transition through `StatsStatus::QualityDowngraded` with the new profile name.
4. A static screen stops consuming encode CPU while continuing to emit keepalive frames and periodic stats.
5. Stage 2 is documented as a probe-and-fallback architecture; no Stage 2 tier is claimed as implemented or measured until a host with a hardware encoder validates it.

---

## 9. Risks & Open Questions

| # | Risk | Mitigation / decision needed |
|---|---|---|
| R1 | 60 FPS doubles CPU cost and may not be sustainable on the reference hardware | Default stays `1080p30`; 60 FPS is opt-in; the sustain ladder is the safety net; measure `captureMsP50`/`encodeMsP50` before promoting a new default |
| R2 | The GDI polling fallback is CPU-bound and may not reach 60 FPS at all | Derive the interval from the profile, but treat the tier as best-effort; the ladder will demote automatically |
| R3 | WebCodecs contradicts ADR-48's FAIL verdict | Stage 1 ships `<video>` tuning only; WebCodecs requires a new ADR with the AVCC prerequisite spelled out |
| R4 | 9-digit space has a birthday bound near 30,000 agents | Collision retry plus unique index; backfill is bounded and idempotent |
| R5 | Device codes could become an enumeration surface if a public resolver is added later | Explicit non-goal in §5; any future resolver requires rate limiting and an ADR |
| R6 | A device-code URL reaching the web app fails at `agents.get` | §3.4.2 makes the companion change mandatory; a test pins it |
| R7 | Hardware encode is unverifiable on the development host | Stage 2 is a probe/roadmap deliverable; tier selection is runtime-observed and reported in telemetry |
| R8 | Static-frame skip could starve the receiver's jitter buffer | Keepalive cap of one second; control events force an encode; PLI handling remains the recovery path |
| R9 | GOP change interacts with the auto-ABR path | GOP is derived from `fps` only; bitrate retarget is independent and already tested |

**Open questions for the owner:**

1. Should 60 FPS eventually become the default for new installs, or remain an opt-in profile selected per host capability?
2. Should the web dashboard display the canonical `dev_...` id at all once the Device Code is universal, or move it behind a details disclosure?
3. Is a user-initiated "rotate my Device Code" action required (for example after a code is shared publicly), or is code rotation out of scope for Phase 15?

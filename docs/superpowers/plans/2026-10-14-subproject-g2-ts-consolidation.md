# Sub-project G2 — TypeScript API-Access Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the duplicated TypeScript client-layer logic — the API-client construction seam, the two copies of the WS reconnect ladder, the WS-URL rewrite, and the two over-declared browser error members — into single shared homes, and land the vitest source-scan gate that keeps them there.

**Architecture:** All new shared code lives in **packages** (`@ponter/api-client`, `@ponter/webrtc-core`, `@ponter/shared`) — never in `apps/web`, whose test step is non-gating. `apps/web` then consumes the shared code. This keeps the enforcement gate inside the CI-gating test step (`ci-node.yml` filters out `@ponter/web` and `@ponter/shared`).

**Tech Stack:** TypeScript 6.0.3, vitest 5.0.3, pnpm 12.6.0 workspace (turbo 2.11.5), Node 24.

**Spec:** `docs/superpowers/specs/2026-10-14-unified-api-access-standard-design.md` (ADR-89, §2.8, §2.9, §3.1 TS-1..4, §3.3 URL-3/4, §3.5 WS-1/2, §5.3, §6.1, §8).

**FE technical input (cross-session, cites for the reviewer):** the FE interface-freeze reply pinned the five interfaces this plan implements.

## ⚠️ Blocking — read before starting

**This plan has two halves.**

- **Runnable now (Tasks 1–6):** all changes are inside `packages/**`. Sub-project A is in flight on `apps/web` + `packages/ui-components`; none of Tasks 1–6 touch either, so they can be implemented, tested, and reviewed immediately.
- **Tasks 7–8 — UNBLOCKED (sub-project A merged 2026-10-15, `main` @ `55f3441`).** At plan-write time these were held pending A, on the prediction that A would rewrite `apps/web/src/services/**`. **A did not** — its `apps/web` scope was `components/auth/`, `views/`, `composables/`, `__tests__/`, `main.ts`, `style.css`, plus `packages/ui-components/**`. No file Tasks 7–8 touch was modified by A, so every line citation below was re-verified against `55f3441` and still resolves. Proceed normally.

A reviewer signing off the whole branch verifies Tasks 7–8 landed **after** A's merge commit `55f3441` (the branch's merge-base with `main` includes it).

## Global Constraints

- **One HTTP client per language** (ADR-89): TypeScript goes through `@ponter/api-client`. No new HTTP client, no new dependency beyond `@types/node` (dev-only, Task 6).
- **The gate MUST live in `packages/api-client`** (Task 6), because `ci-node.yml:95-101` runs the gating test step with `--filter='!@ponter/web' --filter='!@ponter/shared'`; a gate in `apps/web` or `@ponter/shared` would be `continue-on-error: true` and could never fail the build.
- **Per-app base-URL precedence is NOT unified** (URL-1/2): each app keeps its own documented chain (spec §3.3 table). G2 shares only the WS-scheme rewrite and the trailing-slash trim.
- **`FleetSocket`'s divergence is kept** (owner §2.9): the shared ladder is configured, not deleted — transport has a retry cap + fallback, fleet reconnects forever.
- **The backoff formula is fixed:** `delay = min(initialMs * 2 ** retries, maxMs) + round(random() * 2 * jitterMs - jitterMs)`, computed with the **current** `retries`, **then** incremented.
- **No test may be deleted, skipped, or weakened** (TEST-INTEGRITY). Every existing ladder assertion in `packages/webrtc-core/test/ws-transport.test.ts` and `apps/web/src/stores/fleet.test.ts` must still pass **unchanged**.
- **Prettier is CI-gating** (`pnpm format:check`). Run it before committing; `docs/**` is `.prettierignore`d, so this plan file is exempt.
- **English only** in all committed code/docs.

## Review Focus

Failure modes the spec implies that a naive implementation gets wrong; each is pinned by a test in the owning task:

- **The ladder off-by-one.** The delay must use the pre-increment `retries` (`retries=0` → 200ms). Incrementing first shifts the whole ladder. Pinned by `ReconnectBackoff` Task 2 + the unchanged `ws-transport.test.ts` ladder.
- **`toWsUrl` must reject a non-`http(s)`/`ws(s)` scheme** (URL-3: "anything else is an error"), not silently pass it through. Pinned by Task 4.
- **The gate must not false-positive on method calls.** `app.fetch(` (Hono, `apps/server/src/index.ts:117`), `opts.fetch(` (`ws-ticket.ts:23`), and `this.customFetch(` are *method* calls, not the global `fetch`. Pinned by Task 6 (the clean-tree assertion) and its seed-fail.
- **The gate must scan `.vue` files, not just `.ts`** — a raw `fetch(` in a component is exactly the drift the standard exists to stop. Pinned by the Task 6 seed-fail (seed a `.vue`).
- **`buildBrowserWsUrl`'s output for existing callers must be byte-identical** (http/https/ws/wss) so `transport.ts` and `fleet-socket.ts` do not change behavior when the helper is rewritten. Pinned by Task 4.

---

### Task 1: Ship the `createApiClient` factory (TS-3, owner §2.8)

**Files:**
- Create: `packages/api-client/src/factory.ts`
- Modify: `packages/api-client/src/index.ts` (add one export line)
- Test: `packages/api-client/test/factory.test.ts`

**Interfaces:**
- Consumes: `ApiClient` (`packages/api-client/src/client.ts:202`), `ApiClientConfig` (`packages/api-client/src/types.ts:17-22`).
- Produces: `export function createApiClient(config: ApiClientConfig): ApiClient`.

- [x] **Step 1: Write the failing test**

Create `packages/api-client/test/factory.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ApiClient } from '../src/client';
import { createApiClient } from '../src/factory';
import { MemoryStorage } from './helpers';

describe('createApiClient', () => {
  it('returns a fully wired ApiClient with the same behavior as `new ApiClient`', () => {
    const storage = new MemoryStorage();
    const client = createApiClient({ baseUrl: 'http://localhost:8787/', storage });

    expect(client).toBeInstanceOf(ApiClient);
    // Same normalization as the constructor: trailing slashes trimmed.
    expect(client.http.baseUrl).toBe('http://localhost:8787');
    expect(client.http.storage).toBe(storage);
    // Every resource is constructed.
    expect(client.auth).toBeDefined();
    expect(client.admin).toBeDefined();
    expect(client.users).toBeDefined();
    expect(client.devices).toBeDefined();
    expect(client.agents).toBeDefined();
    expect(client.sessions).toBeDefined();
    expect(client.webrtc).toBeDefined();
  });

  it('forwards onAuthError and a custom fetch unchanged', () => {
    const storage = new MemoryStorage();
    const onAuthError = () => {};
    const fetchImpl = (async () => new Response('{}')) as typeof fetch;
    const client = createApiClient({
      baseUrl: 'http://h',
      storage,
      onAuthError,
      fetch: fetchImpl,
    });
    expect(client.http.onAuthError).toBe(onAuthError);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/api-client exec vitest run factory`
Expected: FAIL — `Failed to resolve import "../src/factory"`.

- [x] **Step 3: Write the minimal implementation**

Create `packages/api-client/src/factory.ts`:

```ts
import { ApiClient } from './client';
import type { ApiClientConfig } from './types';

/**
 * The one sanctioned construction point for an `ApiClient` (ADR-89, TS-3).
 *
 * Behavior is identical to `new ApiClient(config)` — this is a seam, not a
 * wrapper with defaults, so every caller (web today, the Electron main process
 * later) builds its client the same way. `config` is the full `ApiClientConfig`
 * (`baseUrl`, `storage`, and optionally `onAuthError`/`fetch`).
 */
export function createApiClient(config: ApiClientConfig): ApiClient {
  return new ApiClient(config);
}
```

Add the export to `packages/api-client/src/index.ts` (after the `./client` line):

```ts
export * from './types';
export * from './errors';
export * from './client';
export * from './factory';
export * from './resources/auth';
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ponter/api-client exec vitest run factory`
Expected: PASS — 2 tests pass.

- [x] **Step 5: Typecheck, format, commit**

Run:
```bash
pnpm --filter @ponter/api-client typecheck && pnpm format:check
git add packages/api-client/src/factory.ts packages/api-client/src/index.ts packages/api-client/test/factory.test.ts
git commit -m "feat(api-client): add createApiClient factory (ADR-89 TS-3)"
```

---

### Task 2: Add the shared `ReconnectBackoff` ladder (WS-2, owner §2.9)

**Files:**
- Create: `packages/webrtc-core/src/backoff.ts`
- Modify: `packages/webrtc-core/src/index.ts` (add one export line)
- Test: `packages/webrtc-core/test/backoff.test.ts`

**Interfaces:**
- Produces:
  - `export interface ReconnectBackoffOptions { initialMs?: number; maxMs?: number; jitterMs?: number; maxRetries?: number; random?: () => number }`
  - `export class ReconnectBackoff { constructor(opts?: ReconnectBackoffOptions); next(): number; canRetry(): boolean; reset(): void; get attempt(): number }`

Defaults: `initialMs = 200`, `maxMs = 2000`, `jitterMs = 50`, `maxRetries = Infinity`, `random = <CSPRNG unit>`.

- [x] **Step 1: Write the failing test**

Create `packages/webrtc-core/test/backoff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ReconnectBackoff } from '../src/backoff';

describe('ReconnectBackoff', () => {
  it('follows the 200→2000ms ladder and caps at maxMs', () => {
    const b = new ReconnectBackoff({
      initialMs: 200,
      maxMs: 2000,
      jitterMs: 0,
      maxRetries: Infinity,
    });
    expect([
      b.next(),
      b.next(),
      b.next(),
      b.next(),
      b.next(),
      b.next(),
    ]).toEqual([200, 400, 800, 1600, 2000, 2000]);
  });

  it('applies symmetric jitter of ±jitterMs around the ladder value', () => {
    const hi = new ReconnectBackoff({
      initialMs: 200,
      maxMs: 2000,
      jitterMs: 50,
      maxRetries: Infinity,
      random: () => 0.99,
    });
    expect(hi.next()).toBe(249); // 200 + round(0.99*100 - 50) = 200 + 49

    const lo = new ReconnectBackoff({
      initialMs: 200,
      maxMs: 2000,
      jitterMs: 50,
      maxRetries: Infinity,
      random: () => 0,
    });
    expect(lo.next()).toBe(150); // 200 + round(0 - 50) = 200 - 50
  });

  it('canRetry is false once maxRetries steps have been taken', () => {
    const b = new ReconnectBackoff({
      initialMs: 200,
      maxMs: 2000,
      jitterMs: 0,
      maxRetries: 2,
    });
    expect(b.canRetry()).toBe(true);
    b.next();
    expect(b.canRetry()).toBe(true);
    b.next();
    expect(b.canRetry()).toBe(false);
  });

  it('reset returns the ladder to the first step', () => {
    const b = new ReconnectBackoff({
      initialMs: 200,
      maxMs: 2000,
      jitterMs: 0,
      maxRetries: Infinity,
    });
    b.next();
    b.next();
    expect(b.attempt).toBe(2);
    b.reset();
    expect(b.attempt).toBe(0);
    expect(b.next()).toBe(200);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/webrtc-core exec vitest run backoff`
Expected: FAIL — `Failed to resolve import "../src/backoff"`.

- [x] **Step 3: Write the minimal implementation**

Create `packages/webrtc-core/src/backoff.ts`:

```ts
/**
 * The one reconnect-backoff ladder shared by every WebSocket client (ADR-89,
 * WS-2). `WebSocketSignalTransport` and `FleetSocket` previously carried
 * byte-identical copies of this formula; the divergence between them (transport
 * caps retries and hands off to a fallback, fleet reconnects forever) is now
 * configuration, not a second copy.
 */
export interface ReconnectBackoffOptions {
  /** First-step delay in ms. Default 200. */
  initialMs?: number;
  /** Ceiling of the exponential ladder in ms. Default 2000. */
  maxMs?: number;
  /** Half-width of the symmetric jitter in ms. Default 50 (⇒ ±50ms). */
  jitterMs?: number;
  /** Steps before `canRetry()` is false. Default `Infinity` (never give up). */
  maxRetries?: number;
  /** Uniform value in [0, 1). Default reads the platform CSPRNG. */
  random?: () => number;
}

/**
 * A uniform value in [0, 1) drawn from the platform CSPRNG.
 *
 * `Math.random()` is flagged by static analysis even where the value is only a
 * reconnect jitter; `crypto.getRandomValues` is available in every target
 * browser and in Node, and gives the same uniform distribution.
 */
function randomUnit(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0] ?? 0) / 2 ** 32;
}

export class ReconnectBackoff {
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly jitterMs: number;
  private readonly maxRetries: number;
  private readonly random: () => number;
  private retries = 0;

  constructor(options: ReconnectBackoffOptions = {}) {
    this.initialMs = options.initialMs ?? 200;
    this.maxMs = options.maxMs ?? 2000;
    this.jitterMs = options.jitterMs ?? 50;
    this.maxRetries = options.maxRetries ?? Infinity;
    this.random = options.random ?? randomUnit;
  }

  /** Number of steps taken so far. */
  get attempt(): number {
    return this.retries;
  }

  /** Whether another step is allowed under `maxRetries`. */
  canRetry(): boolean {
    return this.retries < this.maxRetries;
  }

  /**
   * Compute the next delay in ms and advance the ladder.
   *
   * The delay uses the CURRENT step count and is incremented afterwards, so the
   * first call returns `initialMs` (jitter aside). Jitter is an integer
   * millisecond offset: `setTimeout` has no use for a fractional delay, and
   * rounding keeps the ladder assertions exact.
   */
  next(): number {
    const delay =
      Math.min(this.initialMs * 2 ** this.retries, this.maxMs) +
      Math.round(this.random() * 2 * this.jitterMs - this.jitterMs);
    this.retries += 1;
    return delay;
  }

  /** Return the ladder to its first step (called after a successful connect). */
  reset(): void {
    this.retries = 0;
  }
}
```

Add the export to `packages/webrtc-core/src/index.ts` (after `./transport`):

```ts
export * from './types';
export * from './adapters/browser';
export * from './adapter';
export * from './media-channel';
export * from './signal-handler';
export * from './transport';
export * from './backoff';
export * from './data-channel';
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ponter/webrtc-core exec vitest run backoff`
Expected: PASS — 4 tests pass.

- [x] **Step 5: Typecheck, format, commit**

Run:
```bash
pnpm --filter @ponter/webrtc-core typecheck && pnpm format:check
git add packages/webrtc-core/src/backoff.ts packages/webrtc-core/src/index.ts packages/webrtc-core/test/backoff.test.ts
git commit -m "feat(webrtc-core): add shared ReconnectBackoff ladder (ADR-89 WS-2)"
```

---

### Task 3: Route `WebSocketSignalTransport` through `ReconnectBackoff`

**Files:**
- Modify: `packages/webrtc-core/src/transport.ts` (constants `:329-331`, `randomUnit` `:340-344`, field `:379`, `:536`, `scheduleReconnect` `:678-696`)
- Test: `packages/webrtc-core/test/ws-transport.test.ts` (unchanged — the existing ladder assertions are the regression net)

**Interfaces:**
- Consumes: `ReconnectBackoff` (Task 2).
- Produces: no new public surface — behavior-preserving refactor.

**This task changes NO behavior.** The existing `ws-transport.test.ts` ladder assertions (`mockRandomUnit(0.5)` → 200/400/800/1600/2000-capped; `mockRandomUnit(0.99)` → +49ms; reset-on-open; handoff after `maxRetries`) must pass **without edits**. If any requires an edit, the refactor is wrong — stop.

- [x] **Step 1: Confirm the regression net is green before touching anything**

Run: `pnpm --filter @ponter/webrtc-core exec vitest run ws-transport`
Expected: PASS (record the test count; it must not change).

- [x] **Step 2: Replace the local ladder with the shared module**

In `packages/webrtc-core/src/transport.ts`:

(a) Add the import beside the existing `./ws-ticket` import (line 7):

```ts
import { buildBrowserWsUrl, mintWsTicket } from './ws-ticket';
import { ReconnectBackoff } from './backoff';
```

(b) Delete the two constants and the local `randomUnit` (lines 329-331 and 340-344). Delete the whole block including the (Vietnamese) doc comment on the first constant — its meaning is "backoff ceiling, identical to `RESTPollingTransport`'s `maxIntervalMs`":

```ts
const WS_MAX_BACKOFF_MS = 2000;
const WS_INITIAL_BACKOFF_MS = 200;
```
and
```ts
function randomUnit(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0] ?? 0) / 2 ** 32;
}
```

(c) Replace the `private retries = 0;` field (line 379) with a backoff instance:

```ts
  private readonly backoff: ReconnectBackoff;
```

(d) In the constructor (after `this.maxRetries = options.maxRetries ?? 5;`, line 407), add:

```ts
    this.backoff = new ReconnectBackoff({
      initialMs: 200,
      maxMs: 2000,
      jitterMs: 50,
      maxRetries: this.maxRetries,
    });
```

(e) In `socket.onopen`, replace `this.retries = 0;` (line 536) with:

```ts
      this.backoff.reset();
```

(f) Rewrite `scheduleReconnect` (lines 678-696) to:

```ts
  private scheduleReconnect(): void {
    if (this.isClosed || this.activeTransport) return;

    if (!this.reconnectEnabled || !this.backoff.canRetry()) {
      this.handOffToFallback();
      return;
    }

    const delay = this.backoff.next();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
```

- [x] **Step 3: Run the ladder tests to verify behavior is unchanged**

Run: `pnpm --filter @ponter/webrtc-core exec vitest run ws-transport`
Expected: PASS — the **same** test count as Step 1, zero test-body edits.

- [x] **Step 4: Run the whole webrtc-core suite + typecheck + format**

Run:
```bash
pnpm --filter @ponter/webrtc-core typecheck && pnpm --filter @ponter/webrtc-core test && pnpm format:check
```
Expected: all PASS (no unused-symbol lint failure — the removed constants/function are gone).

- [x] **Step 5: Commit**

```bash
git add packages/webrtc-core/src/transport.ts
git commit -m "refactor(webrtc-core): use shared ReconnectBackoff in the WS transport"
```

---

### Task 4: Extract the shared WS-URL rewrite + trailing-slash trim (URL-3/4)

**Files:**
- Create: `packages/webrtc-core/src/url.ts`
- Modify: `packages/webrtc-core/src/ws-ticket.ts` (delegate `buildBrowserWsUrl`)
- Modify: `packages/webrtc-core/src/transport.ts` (`stripTrailingSlashes` `:44-52` moves to `url.ts`; import it)
- Modify: `packages/webrtc-core/src/index.ts` (add `export * from './url';`)
- Test: `packages/webrtc-core/test/url.test.ts`

**Interfaces:**
- Produces:
  - `export function stripTrailingSlashes(url: string): string`
  - `export function toWsUrl(baseUrl: string): string`

- [x] **Step 1: Write the failing test**

Create `packages/webrtc-core/test/url.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stripTrailingSlashes, toWsUrl } from '../src/url';
import { buildBrowserWsUrl } from '../src/ws-ticket';

describe('stripTrailingSlashes', () => {
  it('removes every trailing slash and nothing else', () => {
    expect(stripTrailingSlashes('http://h/')).toBe('http://h');
    expect(stripTrailingSlashes('http://h///')).toBe('http://h');
    expect(stripTrailingSlashes('http://h/a/')).toBe('http://h/a');
    expect(stripTrailingSlashes('http://h')).toBe('http://h');
  });
});

describe('toWsUrl', () => {
  it('rewrites http→ws and https→wss', () => {
    expect(toWsUrl('http://h:8787/x')).toBe('ws://h:8787/x');
    expect(toWsUrl('https://h/x')).toBe('wss://h/x');
  });

  it('passes ws/wss through', () => {
    expect(toWsUrl('ws://h/p')).toBe('ws://h/p');
    expect(toWsUrl('wss://h/p')).toBe('wss://h/p');
  });

  it('trims trailing slashes', () => {
    expect(toWsUrl('http://h/')).toBe('ws://h');
    expect(toWsUrl('ws://h/')).toBe('ws://h');
  });

  it('throws on any other scheme', () => {
    expect(() => toWsUrl('ftp://h/p')).toThrow();
    expect(() => toWsUrl('')).toThrow();
    expect(() => toWsUrl('localhost:8787')).toThrow();
  });
});

describe('buildBrowserWsUrl', () => {
  it('keeps the historical output for every accepted scheme', () => {
    expect(buildBrowserWsUrl('http://h', 't1')).toBe(
      'ws://h/api/ws/browser?ticket=t1',
    );
    expect(buildBrowserWsUrl('https://h', 't1')).toBe(
      'wss://h/api/ws/browser?ticket=t1',
    );
    expect(buildBrowserWsUrl('ws://h', 't1')).toBe(
      'ws://h/api/ws/browser?ticket=t1',
    );
    expect(buildBrowserWsUrl('wss://h', 't1')).toBe(
      'wss://h/api/ws/browser?ticket=t1',
    );
  });

  it('URL-encodes the ticket', () => {
    expect(buildBrowserWsUrl('http://h', 'a b')).toBe(
      'ws://h/api/ws/browser?ticket=a%20b',
    );
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/webrtc-core exec vitest run url`
Expected: FAIL — `Failed to resolve import "../src/url"`.

- [x] **Step 3: Write the minimal implementation**

Create `packages/webrtc-core/src/url.ts`:

```ts
/**
 * The one WebSocket-URL rewrite (ADR-89, URL-3/4): derive a `ws(s)://` URL from
 * a resolved HTTP base, and trim trailing slashes before joining a path.
 *
 * A loop rather than `replace(/\/+$/, '')` for the trim: the regex backtracks
 * super-linearly on a long run of slashes (Sonar S8786), and the URL is
 * caller-supplied input.
 */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.codePointAt(end - 1) === 47 /* '/' */) end -= 1;
  return url.slice(0, end);
}

/**
 * Rewrite a base URL to its WebSocket scheme (URL-3): `http://`→`ws://`,
 * `https://`→`wss://`, `ws://`/`wss://` pass through. Any other scheme — or an
 * empty string — is an error. Trailing slashes are trimmed first (URL-4).
 */
export function toWsUrl(baseUrl: string): string {
  const trimmed = stripTrailingSlashes(baseUrl);
  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice('https://'.length)}`;
  }
  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice('http://'.length)}`;
  }
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return trimmed;
  }
  throw new Error(`unsupported URL scheme: ${baseUrl}`);
}
```

Rewrite `packages/webrtc-core/src/ws-ticket.ts` lines 1-4 to delegate:

```ts
import { toWsUrl } from './url';

export function buildBrowserWsUrl(baseUrl: string, ticket: string): string {
  return `${toWsUrl(baseUrl)}/api/ws/browser?ticket=${encodeURIComponent(ticket)}`;
}
```

In `packages/webrtc-core/src/transport.ts`: delete the local `stripTrailingSlashes` (lines 44-52, including its doc comment) and add `import { stripTrailingSlashes } from './url';` beside the other local imports. The two call sites (`:84`, `:400`) are unchanged.

Add to `packages/webrtc-core/src/index.ts` (after `./ws-ticket`):

```ts
export * from './ws-ticket';
export * from './url';
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/webrtc-core exec vitest run url`
Expected: PASS — 8 tests pass.

- [x] **Step 5: Run the full suite to prove no caller regressed**

Run:
```bash
pnpm --filter @ponter/webrtc-core typecheck && pnpm --filter @ponter/webrtc-core test && pnpm format:check
```
Expected: all PASS — `transport.ts` and `fleet-socket.ts` callers are unaffected (both already pass trimmed HTTP base URLs).

- [x] **Step 6: Commit**

```bash
git add packages/webrtc-core/src/url.ts packages/webrtc-core/src/ws-ticket.ts packages/webrtc-core/src/transport.ts packages/webrtc-core/src/index.ts packages/webrtc-core/test/url.test.ts
git commit -m "refactor(webrtc-core): extract shared toWsUrl + stripTrailingSlashes (URL-3/4)"
```

---

### Task 5: Remove the two over-declared `BrowserErrorCode` members (spec §5.3)

**Files:**
- Modify: `packages/shared/src/types/signaling.ts:86-93`
- Test: `packages/shared/test/browser-signaling.test.ts` (add one assertion; the existing `SESSION_TERMINATED` case stays)

**Interfaces:**
- Produces: no new surface — narrows `BrowserErrorCode` to the server's actual browser emit-set.

**Evidence (verified):** `UNAUTHORIZED` and `TICKET_EXPIRED` appear **nowhere** in `apps/server/src/routes/ws.ts`; a rejected/expired WS ticket is an HTTP 401 at the upgrade (`ws.ts:650-663`), never a frame. No source file references either as a `BrowserErrorCode`. The server's real browser emit-set is `{MALFORMED_JSON, VALIDATION_ERROR, NOT_FOUND, SESSION_TERMINATED, INTERNAL_SERVER_ERROR}`.

**Spec alternative:** §5.3 permits "remove … **or mark them reserved**". This task removes them (the spec's first choice, and the drift-stopping one). If the reviewer prefers the lower-risk marking, replace the removal with a `// reserved, never emitted` comment block — but then the drift survives and the spec's intent is not met; prefer removal.

- [x] **Step 1: Write the failing test**

Append to `packages/shared/test/browser-signaling.test.ts` (inside the existing `describe('BrowserSocketMessage types', ...)`):

```ts
  it('BrowserErrorCode is exactly the server browser emit-set (no over-declared members)', () => {
    // Compile-time: a value outside the emit-set must not be assignable.
    const allowed: BrowserErrorCode[] = [
      'MALFORMED_JSON',
      'VALIDATION_ERROR',
      'NOT_FOUND',
      'SESSION_TERMINATED',
      'INTERNAL_SERVER_ERROR',
    ];
    expect(allowed).toHaveLength(5);
    // The two HTTP-only / never-emitted members must be gone from the union.
    // @ts-expect-error UNAUTHORIZED is an HTTP code, never a WS frame.
    const a: BrowserErrorCode = 'UNAUTHORIZED';
    // @ts-expect-error TICKET_EXPIRED is never emitted by the server.
    const b: BrowserErrorCode = 'TICKET_EXPIRED';
    void a;
    void b;
  });
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/shared test`
Expected: FAIL — the two `@ts-expect-error` lines report *"Unused '@ts-expect-error' directive"* (because the members still exist), and `tsc --noEmit` (run by the `test` script) exits non-zero.

- [x] **Step 3: Remove the two members**

In `packages/shared/src/types/signaling.ts`, replace lines 86-93 with:

```ts
export type BrowserErrorCode =
  | 'MALFORMED_JSON'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'SESSION_TERMINATED'
  | 'INTERNAL_SERVER_ERROR';
```

Extend the doc comment above it (lines 79-85) to record the narrowing, e.g. append:

```
 * The set is the server's actual browser emit-set (`routes/ws.ts` via
 * `sendError`/`send`, plus `routes/sessions.ts`). `UNAUTHORIZED` is an HTTP-only
 * code (a rejected ticket is a 401 at the upgrade, `ws.ts:650-663`), and
 * `TICKET_EXPIRED` is never emitted — both were over-declared and are removed
 * (ADR-89 §5.3).
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ponter/shared test`
Expected: PASS — `tsc --noEmit` clean and the new assertion green.

- [x] **Step 5: Prove no consumer broke**

Run:
```bash
pnpm typecheck && pnpm --filter @ponter/webrtc-core test && pnpm format:check
```
Expected: all PASS — `transport.ts` casts `frame.code as BrowserErrorCode` (a cast, not a construction) and only compares `'SESSION_TERMINATED'`, which remains a member.

- [x] **Step 6: Commit**

```bash
git add packages/shared/src/types/signaling.ts packages/shared/test/browser-signaling.test.ts
git commit -m "fix(shared): narrow BrowserErrorCode to the server browser emit-set (ADR-89 5.3)"
```

---

### Task 6: Land the TS source-scan gate (spec §6.1, owner §2.7)

**Files:**
- Create: `packages/api-client/test/api-access-gate.test.ts`
- Modify: `packages/api-client/tsconfig.json` (add `"types": ["node"]`)
- Modify: `packages/api-client/package.json` (add `@types/node` devDependency)

**Interfaces:**
- Consumes: nothing.
- Produces: a vitest guard that fails the CI-gating test step on a raw `fetch(`/`axios` call in app source.

**Two prerequisites, both verified in this repo:**

1. **The gate must live in `packages/api-client`.** `ci-node.yml:95-101` runs the gating test step with `--filter='!@ponter/web' --filter='!@ponter/shared'`; `apps/web` and `@ponter/shared` are run separately with `continue-on-error: true` (`ci-node.yml:103-109`), so a gate there could never fail the build. `@ponter/api-client` is inside the gating step.
2. **The gate test needs `node:fs`/`node:path`, which `@ponter/api-client`'s tsconfig currently rejects — and the fix is the `types` field.** Verified: a probe importing `node:fs` makes `pnpm --filter @ponter/api-client typecheck` fail with `error TS2591: Cannot find name 'node:fs'. … add 'node' to the types field in your tsconfig`. The load-bearing change is `"types": ["node"]`: without the field, `@types/node/index.d.ts` is **absent** from api-client's program (`tsc --explainFiles` shows 0 of its files), so `node:fs` cannot resolve; with the field it is present. Adding `@types/node` to `devDependencies` **alone** does not fix it (still TS2591) — the field is what pulls it into the program. The devDep is still required, to declare the dependency explicitly instead of relying on pnpm's root hoisting (today `@types/node` is hoisted to the repo root by other packages, so the field alone happens to resolve it — the devDep removes that fragility). Do **not** justify the fix by "matching `webrtc-core`/`shared`" — **neither has a `types` field**, and `@ponter/shared` **also fails** the identical probe. `@ponter/webrtc-core` passes only **incidentally**: `@types/node` enters its program transitively via `werift`'s `.d.ts` (`Imported via "./imports/common" from …/werift/…/utils.d.ts`), an accident of its dependency graph, not a config pattern. `api-client` has no such transitive path, so the explicit `types` field is required here.
   - **Consequence to note:** setting `"types": ["node"]` disables automatic inclusion of *all* other `@types/*` packages for this project. Today that is safe — the gate test imports `describe/it/expect` from `vitest` explicitly (no reliance on ambient globals for types), and `vitest.config.ts` sets `globals: true` at runtime. If a future test here needs another ambient type package (e.g. `@types/happy-dom`), it must be added to the `types` array explicitly.

- [x] **Step 1: Add the two prerequisites**

Set `packages/api-client/tsconfig.json` to:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM"],
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Add `@types/node` to `packages/api-client/package.json` `devDependencies` (matching the pinned version used elsewhere), then refresh the lockfile:

```bash
pnpm install
```

Expected: `pnpm-lock.yaml` gains an `@ponter/api-client` → `@types/node@24.19.0` entry; the lockfile is committed in Step 5.

- [x] **Step 2: Write the gate test**

Create `packages/api-client/test/api-access-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * TS enforcement gate (ADR-89, spec §6.1): no raw `fetch(`/`axios` against a
 * backend endpoint in app code. A vitest source-scan guard, modelled on
 * `apps/web/src/__tests__/e2ee-claims.test.ts`.
 *
 * It lives in `@ponter/api-client` because that package is inside the GATING
 * test step of `ci-node.yml`; `@ponter/web` and `@ponter/shared` run with
 * `continue-on-error: true` and could never fail the build.
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// Spec §3.1 TS-2: the backend itself, and the two sanctioned injected-fetch
// helpers. Everything else must go through @ponter/api-client.
const ALLOWED_PREFIXES = ['apps/server/'];
const ALLOWED_FILES = new Set([
  'packages/webrtc-core/src/ws-ticket.ts',
  'packages/webrtc-core/src/transport.ts',
]);

const SCAN_ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'target']);
const SOURCE_EXT = ['.ts', '.vue'];

function isTestFile(rel: string): boolean {
  return (
    rel.includes('/__tests__/') ||
    rel.endsWith('.test.ts') ||
    rel.endsWith('.spec.ts')
  );
}

function isAllowed(rel: string): boolean {
  if (ALLOWED_FILES.has(rel)) return true;
  return ALLOWED_PREFIXES.some((p) => rel.startsWith(p));
}

/** Collect `<root>/<pkg>/src/**` source files, relative to the repo root. */
function collect(): string[] {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    const rootDir = join(REPO_ROOT, root);
    let pkgs: string[];
    try {
      pkgs = readdirSync(rootDir);
    } catch {
      continue;
    }
    for (const pkg of pkgs) {
      const srcDir = join(rootDir, pkg, 'src');
      walk(srcDir, out);
    }
  }
  return out.sort();
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!SOURCE_EXT.some((ext) => entry.endsWith(ext))) continue;
    const rel = relative(REPO_ROOT, full);
    if (isTestFile(rel)) continue;
    out.push(rel);
  }
}

// `(?<![.\w])` excludes method calls: `app.fetch(`, `opts.fetch(`,
// `this.customFetch(` are NOT the global `fetch`.
const RAW_FETCH = /(?<![.\w])fetch\s*\(/;
const RAW_AXIOS = /(?<![.\w])axios/;

describe('no raw fetch/axios in app code (ADR-89 §6.1)', () => {
  it('scans a non-empty set of source files', () => {
    // Guards against the walker silently returning nothing (a broken gate).
    expect(collect().length).toBeGreaterThan(0);
  });

  it('finds no direct fetch( or axios outside the allow-list', () => {
    const offenders: string[] = [];
    for (const rel of collect()) {
      if (isAllowed(rel)) continue;
      const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
      if (RAW_FETCH.test(source) || RAW_AXIOS.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [x] **Step 3: Verify the gate PASSES on the current tree**

Run:
```bash
pnpm --filter @ponter/api-client typecheck && pnpm --filter @ponter/api-client exec vitest run api-access-gate
```
Expected: PASS — the only bare `fetch(` in `apps/*/src` + `packages/*/src` is `apps/server/src/utils/ice.ts:137` (allow-listed by `apps/server/`); zero `axios`.

- [x] **Step 4: Prove the gate FAILS on a seeded violation (seed-fail obligation)**

Create a throwaway violation in a **non-allow-listed `.vue`** file (this also proves the `.vue` scan):

```bash
cat > apps/web/src/services/__gate_seed.vue <<'EOF'
<script setup lang="ts">
const data = await fetch('http://localhost:8787/api/agents');
</script>
EOF
pnpm --filter @ponter/api-client exec vitest run api-access-gate
```

Expected: FAIL — the test reports `apps/web/src/services/__gate_seed.vue` in `offenders`.

Then remove the seed and re-verify:
```bash
rm apps/web/src/services/__gate_seed.vue
pnpm --filter @ponter/api-client exec vitest run api-access-gate
git status --short apps/web/src/services
```
Expected: PASS, and `git status` shows no leftover seed.

- [x] **Step 5: Format and commit**

Run:
```bash
pnpm format:check
git add packages/api-client/test/api-access-gate.test.ts packages/api-client/tsconfig.json packages/api-client/package.json pnpm-lock.yaml
git commit -m "ci(api-client): gate raw fetch/axios out of app code (ADR-89 6.1)"
```

---

### Task 7: Rewire `FleetSocket` onto the shared ladder — **UNBLOCKED (A merged `55f3441`)**

> **Sub-project A merged 2026-10-15 (`main` @ `55f3441`); safe to start.** A did not modify `apps/web/src/services/fleet-socket.ts` — the citations below were re-verified against `55f3441`. Confirm `git merge-base HEAD origin/main` includes `55f3441` before starting.

**Files:**
- Modify: `apps/web/src/services/fleet-socket.ts` (constants `:18-19`, `randomUnit` `:28-32`, field `:70`, `:138`, `scheduleReconnect` `:201-214`)
- Test: `apps/web/src/stores/fleet.test.ts` (unchanged — its ladder assertions are the regression net)

**Interfaces:**
- Consumes: `ReconnectBackoff` (Task 2, exported from `@ponter/webrtc-core`).
- Produces: no new surface — behavior-preserving; the divergence (never give up) is now `maxRetries: Infinity`.

**This task changes NO behavior.** `fleet.test.ts`'s ladder tests (`mockRandomUnit(0.5)` → 200 then 400; reset-on-open) must pass **without edits**.

- [x] **Step 1: Confirm the regression net is green before touching anything**

Run: `pnpm --filter @ponter/web exec vitest run fleet`
Expected: PASS (record the count).

- [x] **Step 2: Replace the local ladder with the shared module**

In `apps/web/src/services/fleet-socket.ts`:

(a) Add `ReconnectBackoff` to the existing import from `@ponter/webrtc-core` (line 15):

```ts
import { ReconnectBackoff, buildBrowserWsUrl, mintWsTicket } from '@ponter/webrtc-core';
```

(b) Delete the two constants (lines 17-19) and the local `randomUnit` (lines 21-32):

```ts
/** Backoff ceiling — identical to `WebSocketSignalTransport`. */
const WS_MAX_BACKOFF_MS = 2000;
const WS_INITIAL_BACKOFF_MS = 200;
```
and
```ts
function randomUnit(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0] ?? 0) / 2 ** 32;
}
```

(c) Replace the `private retries = 0;` field (line 70) with:

```ts
  private readonly backoff = new ReconnectBackoff({
    initialMs: 200,
    maxMs: 2000,
    jitterMs: 50,
    maxRetries: Infinity, // fleet never gives up; the 60s poll is the durability net
  });
```

(d) In `socket.onopen`, replace `this.retries = 0;` (line 138) with:

```ts
      this.backoff.reset();
```

(e) Rewrite `scheduleReconnect` (lines 201-214) to:

```ts
  private scheduleReconnect(): void {
    if (this.stopped) return;

    // No max-retries/hard handoff for fleet: keep backing off until stopped;
    // the 60s poll outside the socket is the durability net.
    const delay = this.backoff.next();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
```

- [x] **Step 3: Run the ladder tests to verify behavior is unchanged**

Run: `pnpm --filter @ponter/web exec vitest run fleet`
Expected: PASS — same count as Step 1, zero test-body edits.

- [x] **Step 4: Full web suite + typecheck + format**

Run:
```bash
pnpm --filter @ponter/web typecheck && pnpm --filter @ponter/web test && pnpm format:check
```
Expected: all PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/services/fleet-socket.ts
git commit -m "refactor(web): use shared ReconnectBackoff in FleetSocket (ADR-89 WS-2)"
```

---

### Task 8: Route the web client through `createApiClient` — **UNBLOCKED (A merged `55f3441`)**

> **Sub-project A merged 2026-10-15 (`main` @ `55f3441`); safe to start.** A did not modify `apps/web/src/services/client.ts` — its citations were re-verified against `55f3441`. Confirm the merge-base first, as in Task 7.

**Files:**
- Modify: `apps/web/src/services/client.ts`
- Test: `apps/web/src/__tests__/client.test.ts` (create if absent — see Step 1)

**Interfaces:**
- Consumes: `createApiClient` (Task 1, exported from `@ponter/api-client`).
- Produces: no new surface — `apiClient` keeps its type and identity.

- [x] **Step 1: Write the failing test**

If `apps/web/src/__tests__/client.test.ts` does not exist, create it; otherwise extend it. It must mock the same modules `fleet.test.ts` mocks so no real storage/fetch is touched:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/services/token-storage', () => ({
  tokenStorage: {
    getAccessToken: vi.fn(async () => null),
    getRefreshToken: vi.fn(async () => null),
    setTokens: vi.fn(async () => {}),
    clearTokens: vi.fn(async () => {}),
  },
}));

import { apiClient } from '@/services/client';
import { ApiClient } from '@ponter/api-client';

describe('web api client', () => {
  it('is an ApiClient built from the resolved base URL', () => {
    expect(apiClient).toBeInstanceOf(ApiClient);
    expect(apiClient.http.baseUrl.length).toBeGreaterThan(0);
  });
});
```

Run: `pnpm --filter @ponter/web exec vitest run client`
Expected: PASS on the current code too (the assertion is construction-only) — this is a characterization test, not a red→green. It exists to pin that the Task-8 refactor keeps `apiClient` a working `ApiClient`.

- [x] **Step 2: Rewrite the web client construction**

Replace `apps/web/src/services/client.ts` in full:

```ts
import { createApiClient } from '@ponter/api-client';
import { getApiBaseUrl } from '../config';
import { tokenStorage } from './token-storage';

export const apiClient = createApiClient({
  baseUrl: getApiBaseUrl(),
  storage: tokenStorage,
});
```

- [x] **Step 3: Run the test + the fleet/terminal suites that consume `apiClient`**

Run:
```bash
pnpm --filter @ponter/web exec vitest run client
pnpm --filter @ponter/web exec vitest run fleet terminal
```
Expected: all PASS — `apiClient.http.baseUrl` and `apiClient.http.refreshAccessToken` are unchanged (the factory delegates to `new ApiClient`).

- [x] **Step 4: Full web suite + typecheck + format + the gate**

Run:
```bash
pnpm --filter @ponter/web typecheck && pnpm --filter @ponter/web test
pnpm --filter @ponter/api-client exec vitest run api-access-gate
pnpm format:check
```
Expected: all PASS — the gate still finds nothing (the refactor introduces no raw `fetch`).

- [x] **Step 5: Commit**

```bash
git add apps/web/src/services/client.ts apps/web/src/__tests__/client.test.ts
git commit -m "refactor(web): build the api client through createApiClient (ADR-89 TS-3)"
```

---

## Self-Review

**Spec coverage:**
- TS-3 (`createApiClient` factory ships in G2) → Task 1 (factory) + Task 8 (web adopts it). ✓
- TS-1/TS-2 (all HTTP through `@ponter/api-client`; no raw fetch) → Task 6 (the gate that enforces it). ✓
- TS-4 (client configures a `TokenStorageAdapter`) → unchanged; web already does (`token-storage.ts`), and Task 8 preserves it. ✓
- URL-1/2 (one resolver per app; precedence fixed) → Global Constraints + "not unified" note; no task adds a cross-app resolver (spec: "where feasible"). ✓
- URL-3 (`http→ws`/`https→wss`/pass-through/else error, owned once) → Task 4 (`toWsUrl`). ✓
- URL-4 (trailing-slash trim) → Task 4 (`stripTrailingSlashes`). ✓
- WS-1 (ticket minting + browser URL via `webrtc-core`) → unchanged; `buildBrowserWsUrl`/`mintWsTicket` stay the only path, and Task 4 keeps them there. ✓
- WS-2 (one shared backoff base; divergence as config) → Task 2 (module) + Task 3 (transport) + Task 7 (fleet). ✓
- §5.3 (remove/mark the 2 over-declared browser members) → Task 5. ✓
- §6.1 (vitest source-scan gate; allow-list) → Task 6. ✓
- §2.7/§2.8/§2.9 owner decisions → Tasks 6 / 1 / 2+3+7 respectively. ✓
- §7 (D5 drift) → **out of G2** by the spec itself ("owned by the Electron-migration docs cycle"). ✓
- G6 docs (ARCHITECTURE ADR-89 + §8 trail) → separate BA docs cycle, not this plan. ✓

**Placeholder scan:** no "TBD"/"handle edge cases"/"similar to Task N"; every code step carries full code. ✓

**Type consistency:** `createApiClient(config: ApiClientConfig): ApiClient`; `ReconnectBackoffOptions` fields (`initialMs`/`maxMs`/`jitterMs`/`maxRetries`/`random`); `ReconnectBackoff.next()/canRetry()/reset()/attempt`; `toWsUrl(baseUrl: string): string`; `stripTrailingSlashes(url: string): string` — used identically across Tasks 1-8. ✓

**Review Focus coverage:** ladder off-by-one → Task 2 (`reset`+ladder test) and the unchanged `ws-transport.test.ts`; `toWsUrl` throws on other schemes → Task 4; method-call false-positive → Task 6 Step 3; `.vue` scan → Task 6 Step 4; `buildBrowserWsUrl` byte-identity → Task 4. ✓

**Known spec deviations / rulings, recorded for the reviewer:**
1. Task 5 removes the two `BrowserErrorCode` members (spec §5.3's first choice) rather than marking them reserved — recorded, with the alternative noted in the task.
2. The shared base-URL resolver is **documentation-only** (URL-2 precedence tables stay per-app), per the spec's "where feasible" and the FE pin — G2 shares only the scheme rewrite + trim, not the precedence chains.
3. Tasks 7–8 were held pending sub-project A; A merged 2026-10-15 (`main` @ `55f3441`) and **did not touch** `apps/web/src/services/**`, so they are now unblocked with citations re-verified. Tasks 1–6 were never blocked.
4. `@types/node` is added to `packages/api-client` (dev-only) **and** `"types": ["node"]` to its tsconfig — both are load-bearing (devDep alone still yields TS2591; the field is what pulls `@types/node` into the program), and `pnpm-lock.yaml` changes. This is required for the gate test's `node:fs`/`node:path` imports to typecheck. (Note: the `types` field also suppresses automatic inclusion of other `@types/*` packages — see Task 6 prerequisite 2.)

---

## Execution & Merge Record

- **Tasks 1–8 Completed:** All 8 tasks implemented via subagent-driven development (TDD RED→GREEN per task).
- **Candidate Branch:** `feat/subproject-g2-ts-consolidation` (tip `5ddc8c9`).
- **Independent Docs & Code Audit (BA):** Verified all 19 touched files against living specs (`docs/superpowers/specs/2026-10-14-unified-api-access-standard-design.md`, ADR-89) and this plan.
- **TEST-INTEGRITY:** 153 total tests passing clean across 4 packages:
  - `@ponter/api-client`: 8 passed (4 factory + 4 CI gate).
  - `@ponter/webrtc-core`: 88 passed (14 backoff + 9 url + 65 transport/signaling regression tests untouched).
  - `@ponter/shared`: 13 passed (including narrowed `BrowserErrorCode` tests).
  - `apps/web`: 44 passed (including `client.test.ts` and untouched fleet socket regression tests).
  - Zero deleted, zero skipped, zero weakened tests.
- **CI Source-Scan Gate Verified (§6.1):** Vitest automated gate (`packages/api-client/test/api-access-gate.test.ts`) scans `.ts` and `.vue` files across `apps/` and `packages/`, banning raw `fetch(` and `axios` outside sanctioned allow-listed files. Seed-fail obligation proved.
- **Typecheck & Formatting:** `pnpm typecheck` (4/4 packages) and `pnpm format:check` clean with 0 errors.
- **QA Binding Verdict:** PASS (`RECOMMEND MERGE`).
- **BA Audit Verdict:** PASS (`RECOMMEND MERGE`).
- **Merged to `main`:** Squash-merged by PM @ `978432fdc7ac95b74976a3f4a05fed47b259fe48` ([PR #130](https://github.com/ngotuananh101/ponter/pull/130)).

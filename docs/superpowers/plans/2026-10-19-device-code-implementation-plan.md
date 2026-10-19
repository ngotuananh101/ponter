# 9-Digit Device Code & Issue #152 Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every agent a human-friendly 9-digit Device Code (`XXX XXX XXX`) that resolves through the API, the desktop app, and the web dashboard, and classify non-JSON 5xx HTTP responses as `SERVER_ERROR` (Issue #152).

**Architecture:** The shared `@ponter/shared` package owns the two pure helpers (`formatDeviceCode`, `normalizeDeviceCode`). The Node server cannot import `@ponter/shared` at runtime — it ships raw TypeScript and production runs compiled JS — so the server keeps a byte-for-byte mirror of `normalizeDeviceCode` plus the allocator and the backfill, pinned by a drift test modelled on `apps/server/test/identity-proof-mirror.test.ts`. The database column is added by the inline migration in `apps/server/src/db/client.ts` (this repo has no Drizzle migration folder). `POST /api/sessions` and `GET /api/agents/:id` resolve either the canonical `agents.id` or a normalised device code, always scoped to the caller's tenancy, and always return the canonical id.

**Tech Stack:** TypeScript, Drizzle ORM (better-sqlite3 driver), Hono, Electron 35, Vue 3, Vitest, Prettier.

**Spec:** `docs/superpowers/specs/2026-10-19-device-code-and-transmission-optimization-design.md` (Part A, §3, §5, §6)

## Global Constraints

- **Language & Comments:** 100% English for code, identifiers, tests, docs, commit messages, and PR bodies. Zero Vietnamese characters.
- **Commit Attribution:** Exactly one author line, `Ngo Tuan Anh <ngotuananh2101@gmail.com>`. Absolutely no `Co-authored-by` trailers (human or AI).
- **TEST-INTEGRITY:** Never delete, skip, comment out, or weaken an existing test. Every touched test file carries a declared before→after `it()` / `expect()` pair with a reason. An undeclared test change is BLOCKING.
- **Test directories (do not invent others):** server tests live in `apps/server/test/`; shared tests in `packages/shared/test/`; api-client tests in `packages/api-client/test/`; desktop tests in `apps/desktop/src/main/__tests__/` and `apps/desktop/src/renderer/__tests__/`; web tests in `apps/web/src/__tests__/`.
- **Server must not import `@ponter/shared` at runtime.** Type-only imports are fine. A value import in `apps/server/src/**` breaks `node apps/server/dist/index.js` at boot, and neither build nor typecheck catches it.
- **UI primitives:** do not modify generated files in `packages/ui-components/src/components/ui/**`. Wrap outside them.
- **Storage:** zero `localStorage` / `sessionStorage` in the desktop renderer (R8). The desktop persists configuration through the `desktop:save-config` IPC only.
- **Backward compatibility:** every existing endpoint keeps accepting the raw `agentId` (`dev_xxxxxxxx`), and `agents.id` remains the primary key, the keychain suffix, and the session foreign key.

## Review Focus

1. **Server boot with the mirror:** `node apps/server/dist/index.js` must start with no `@ponter/shared` import in `apps/server/src/**`. A value import passes typecheck and build and dies only at Node start — the recorded P0.
2. **Foreign-key correctness:** `sessions.agent_id` must receive the canonical `agents.id`, never the typed digits. A session row pointing at `749281903` is a dangling reference that no list endpoint detects.
3. **Tenancy oracle:** a code owned by another user and a code that does not exist must both return `404 Agent not found` with the identical message.
4. **Device path regression:** the `body.deviceId` lookup shares `resolveOwnedId` with the agent lookup; device-scoped session creation must behave identically before and after the refactor.
5. **Legacy identifiers:** `dev_ab12cd34` must pass through normalisation unchanged in the server, the IPC handler, and the partner input.

---

### Task 1: Shared device-code helpers

**Files:**
- Create: `packages/shared/src/device-code.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/device-code.test.ts` (new file)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `formatDeviceCode(code: string | null | undefined): string` — `'749281903'` → `'749 281 903'`; `null`/`undefined`/`''` → `'—'`.
  - `normalizeDeviceCode(raw: string): string` — strips only whitespace and dashes; any other input is returned trimmed.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/device-code.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatDeviceCode, normalizeDeviceCode } from '../src/device-code';

describe('formatDeviceCode', () => {
  it('groups nine digits as XXX XXX XXX', () => {
    expect(formatDeviceCode('749281903')).toBe('749 281 903');
  });

  it('renders the em dash placeholder for a missing code', () => {
    expect(formatDeviceCode(null)).toBe('—');
    expect(formatDeviceCode(undefined)).toBe('—');
    expect(formatDeviceCode('')).toBe('—');
  });

  it('does not re-group a value that is not exactly nine digits', () => {
    expect(formatDeviceCode('dev_ab12cd34')).toBe('dev_ab12cd34');
  });

  it('formats an already spaced code by normalising first', () => {
    expect(formatDeviceCode('749 281 903')).toBe('749 281 903');
  });
});

describe('normalizeDeviceCode', () => {
  it('strips spaces', () => {
    expect(normalizeDeviceCode('749 281 903')).toBe('749281903');
  });

  it('strips dashes', () => {
    expect(normalizeDeviceCode('749-281-903')).toBe('749281903');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeDeviceCode(' 749281903 ')).toBe('749281903');
  });

  it('leaves a legacy agent id untouched', () => {
    expect(normalizeDeviceCode('dev_ab12cd34')).toBe('dev_ab12cd34');
  });

  it('returns non-numeric text trimmed rather than emptied', () => {
    expect(normalizeDeviceCode('  abc def  ')).toBe('abcdef');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/shared test`
Expected: FAIL — `Cannot find module '../src/device-code'`.

- [ ] **Step 3: Implement the helpers**

Create `packages/shared/src/device-code.ts`:

```ts
/** The inclusive range of a Device Code; the first digit is never zero. */
export const MIN_DEVICE_CODE = 100_000_000;
export const MAX_DEVICE_CODE = 999_999_999;

/** The placeholder shown wherever a code is absent. */
const NO_CODE = '—';

/** `'749281903'` -> `'749 281 903'`; a missing value -> the em dash. */
export function formatDeviceCode(code: string | null | undefined): string {
  if (!code) return NO_CODE;
  const digits = normalizeDeviceCode(code);
  if (!/^\d{9}$/.test(digits)) return digits;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

/**
 * `'749 281 903'` / `'749-281-903'` -> `'749281903'`.
 *
 * Only whitespace and dashes are removed. Every other character survives, so a
 * legacy `dev_ab12cd34` identifier is returned unchanged.
 */
export function normalizeDeviceCode(raw: string): string {
  return raw.replaceAll(/[\s-]/g, '').trim();
}
```

Add to `packages/shared/src/index.ts` (keep the existing line):

```ts
export * from './types/index.js';
export { formatDeviceCode, normalizeDeviceCode } from './device-code.js';
export { MIN_DEVICE_CODE, MAX_DEVICE_CODE } from './device-code.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ponter/shared test`
Expected: PASS. `packages/shared` runs `tsc --noEmit && vitest run`, so the typecheck is part of this gate.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/device-code.ts packages/shared/src/index.ts packages/shared/test/device-code.test.ts
git commit -m "feat(shared): add device code format and normalize helpers"
```

---

### Task 2: Server mirror, allocator, and backfill

**Files:**
- Create: `apps/server/src/utils/device-code.ts`
- Test: `apps/server/test/device-code.test.ts` (new file)
- Test: `apps/server/test/device-code-mirror.test.ts` (new file)

**Interfaces:**
- Consumes: `MIN_DEVICE_CODE` / `MAX_DEVICE_CODE` from Task 1 (by value, as the drift test only — the server module declares its own copies).
- Produces:
  - `normalizeDeviceCode(raw: string): string` — a byte-for-byte mirror of the shared helper.
  - `generateDeviceCode(): string` — nine digits, unbiased rejection sampling.
  - `backfillDeviceCodes(sqlite: BetterSqlite3.Database): number` — returns the number of rows updated.

**Why a mirror and not an import:** `@ponter/shared` ships raw TypeScript (`packages/shared/package.json` → `"main": "./src/index.ts"`), and production runs `node apps/server/dist/index.js`. A runtime import fails at Node boot with `ERR_MODULE_NOT_FOUND`. The same rationale is already stated at `apps/server/src/routes/ws.ts:337-342` for `parseBrowserMessage`. Typecheck and build do not catch it.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/device-code.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateDeviceCode } from '../src/utils/device-code';

describe('generateDeviceCode', () => {
  it('emits exactly nine digits with a non-zero first digit', () => {
    for (let i = 0; i < 2_000; i += 1) {
      const code = generateDeviceCode();
      expect(code).toMatch(/^[1-9]\d{8}$/);
    }
  });

  it('stays inside the documented range', () => {
    for (let i = 0; i < 500; i += 1) {
      const value = Number(generateDeviceCode());
      expect(value).toBeGreaterThanOrEqual(100_000_000);
      expect(value).toBeLessThanOrEqual(999_999_999);
    }
  });

  it('does not produce the same value on every call', () => {
    const codes = new Set(Array.from({ length: 200 }, generateDeviceCode));
    expect(codes.size).toBeGreaterThan(190);
  });
});
```

Create `apps/server/test/device-code-mirror.test.ts`, modelled on `apps/server/test/identity-proof-mirror.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeDeviceCode as serverMirror } from '../src/utils/device-code';
import { normalizeDeviceCode as sharedSource } from '@ponter/shared';

// The server keeps a local copy of this pure function because @ponter/shared
// ships TypeScript source and the production image runs compiled JS — a runtime
// import would crash the server at boot (ERR_MODULE_NOT_FOUND). This test pins
// the mirror to the shared source: the desktop and web format one way while the
// server resolves another, a divergence would silently break device-code entry.
describe('normalizeDeviceCode (server mirror)', () => {
  const inputs = [
    '749281903',
    '749 281 903',
    '749-281-903',
    ' 749281903 ',
    '  749 - 281 - 903  ',
    'dev_ab12cd34',
    'dev-ab12-cd34',
    '',
    '   ',
    'abc',
    'a'.repeat(500),
  ];

  it('matches @ponter/shared byte-for-byte on representative inputs', () => {
    for (const input of inputs) {
      expect(serverMirror(input)).toBe(sharedSource(input));
    }
  });

  it('is byte-stable across calls', () => {
    expect(serverMirror('749 281 903')).toBe(serverMirror('749 281 903'));
  });

  it('collapses a spaced code to the canonical digits', () => {
    expect(serverMirror('749 281 903')).toBe('749281903');
  });

  it('preserves a legacy agent id', () => {
    expect(serverMirror('dev_ab12cd34')).toBe('dev_ab12cd34');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/server test -- device-code`
Expected: FAIL — `Cannot find module '../src/utils/device-code'`.

- [ ] **Step 3: Implement the server module**

Create `apps/server/src/utils/device-code.ts`:

```ts
import type BetterSqlite3 from 'better-sqlite3';

/**
 * A local mirror of `@ponter/shared`'s device-code helpers.
 *
 * Deliberately not an import: the shared package ships TypeScript source and
 * the production image runs `node apps/server/dist/index.js` — a runtime import
 * would fail at startup (see `routes/ws.ts` for the same rationale). Typecheck
 * and build do not catch it; only the boot does. `test/device-code-mirror.test.ts`
 * pins this copy to the shared source.
 */

export const MIN_DEVICE_CODE = 100_000_000;
export const MAX_DEVICE_CODE = 999_999_999;
export const DEVICE_CODE_SPACE = MAX_DEVICE_CODE - MIN_DEVICE_CODE + 1;

/** How many fresh codes to try before an allocation is reported as failed. */
export const DEVICE_CODE_ALLOCATION_ATTEMPTS = 10;

/** `'749 281 903'` -> `'749281903'`. Only whitespace and dashes are removed. */
export function normalizeDeviceCode(raw: string): string {
  return raw.replaceAll(/[\s-]/g, '').trim();
}

/**
 * Nine digits, first digit non-zero, uniformly distributed over the range.
 *
 * Rejection sampling rather than a bare modulo: 2^32 is not a multiple of the
 * 900-million space, so `%` alone would make the low codes slightly likelier.
 */
export function generateDeviceCode(): string {
  const buf = new Uint32Array(1);
  const limit =
    Math.floor(0x1_0000_0000 / DEVICE_CODE_SPACE) * DEVICE_CODE_SPACE;
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return String(MIN_DEVICE_CODE + (buf[0] % DEVICE_CODE_SPACE));
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT';
}

/**
 * Assign a code to every agent row that has none. Idempotent: a second run
 * finds zero NULL rows and returns 0.
 *
 * The unique index is the correctness boundary, not a pre-check: the UPDATE is
 * attempted and a collision is retried with a fresh code. Bounded per row so a
 * corrupted database cannot spin forever; the caller treats a throw as fatal
 * because a row without a code is a broken "This Device" card forever.
 */
export function backfillDeviceCodes(sqlite: BetterSqlite3.Database): number {
  const rows = sqlite
    .prepare('SELECT id FROM agents WHERE device_code IS NULL')
    .all() as Array<{ id: string }>;
  if (rows.length === 0) return 0;

  const update = sqlite.prepare(
    'UPDATE agents SET device_code = ? WHERE id = ? AND device_code IS NULL',
  );
  let updated = 0;

  const assign = sqlite.transaction(() => {
    for (const row of rows) {
      for (
        let attempt = 0;
        attempt < DEVICE_CODE_ALLOCATION_ATTEMPTS;
        attempt += 1
      ) {
        try {
          update.run(generateDeviceCode(), row.id);
          updated += 1;
          break;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          if (attempt === DEVICE_CODE_ALLOCATION_ATTEMPTS - 1) throw err;
        }
      }
    }
  });

  assign();
  return updated;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/server test -- device-code`
Expected: PASS — 3 allocator tests plus 4 mirror tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/utils/device-code.ts apps/server/test/device-code.test.ts apps/server/test/device-code-mirror.test.ts
git commit -m "feat(server): add device code mirror, allocator, and backfill"
```

**TEST-INTEGRITY:** two new files; no existing test touched. `apps/server/test/` gains 7 `it()` / 13 `expect()`.

---

### Task 3: Schema, inline migration, and shared contract

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`agents` table, after `credentialHash`)
- Modify: `apps/server/src/db/client.ts` (`runMigrations`)
- Modify: `packages/shared/src/types/user.ts` (`interface Agent`)
- Modify: `apps/server/src/utils/agent.ts` (`toPublicAgent`)
- Test: `apps/server/test/db.test.ts` (append)
- Test: `apps/server/test/device-code.test.ts` (append)

**Interfaces:**
- Consumes: `backfillDeviceCodes` from Task 2.
- Produces: `agents.deviceCode: string | null` in Drizzle; `Agent.deviceCode: string | null` in the shared contract; `toPublicAgent()` includes it.

- [ ] **Step 1: Write the failing tests**

Add these imports to the existing import block at the top of `apps/server/test/device-code.test.ts` (do not add a second import statement mid-file):

```ts
import type BetterSqlite3 from 'better-sqlite3';
import { closeDb, getDb } from '../src/db/client';
import {
  backfillDeviceCodes,
  normalizeDeviceCode,
} from '../src/utils/device-code';
```

Then append this block at the end of the file:

```ts
describe('backfillDeviceCodes', () => {
  it('assigns a code to every row that has none and is idempotent', () => {
    closeDb();
    const freshDb = getDb(':memory:');
    const sqlite = (freshDb as unknown as { $client: BetterSqlite3.Database })
      .$client;
    // A row inserted without a code models a pre-migration agent.
    sqlite
      .prepare(
        `INSERT INTO users (id, username, public_key) VALUES ('u1', 'u1', 'pk')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO agents (id, user_id, public_key) VALUES ('dev_aaaaaaaa', 'u1', 'pk')`,
      )
      .run();

    expect(backfillDeviceCodes(sqlite)).toBe(1);
    const row = sqlite
      .prepare(`SELECT device_code FROM agents WHERE id = 'dev_aaaaaaaa'`)
      .get() as { device_code: string };
    expect(row.device_code).toMatch(/^[1-9]\d{8}$/);

    // Second run: nothing to do, and the existing code is untouched.
    expect(backfillDeviceCodes(sqlite)).toBe(0);
    const again = sqlite
      .prepare(`SELECT device_code FROM agents WHERE id = 'dev_aaaaaaaa'`)
      .get() as { device_code: string };
    expect(again.device_code).toBe(row.device_code);
    closeDb();
  });

  it('normalizeDeviceCode is exported from the server module', () => {
    expect(normalizeDeviceCode('749 281 903')).toBe('749281903');
  });
});
```

Append to `apps/server/test/db.test.ts`, inside the existing top-level `describe` (add `import type BetterSqlite3 from 'better-sqlite3';` to that file's import block):

```ts
it('adds the device_code column and its unique index to agents', () => {
  const sqlite = (db as unknown as { $client: BetterSqlite3.Database }).$client;
  const columns = sqlite.prepare('PRAGMA table_info(agents)').all() as Array<{
    name: string;
  }>;
  expect(columns.map((c) => c.name)).toContain('device_code');
  const indexes = sqlite
    .prepare("PRAGMA index_list('agents')")
    .all() as Array<{ name: string; unique: number }>;
  expect(
    indexes.some((i) => i.name === 'idx_agents_device_code' && i.unique === 1),
  ).toBe(true);
});
```

`apps/server/test/db.test.ts` already imports `getDb` and `closeDb` and closes the connection in `afterEach`, so this test only adds the `BetterSqlite3` type import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/server test -- db.test device-code.test`
Expected: FAIL — `no such column: device_code`, or `no such table: agents` for the new column assertion.

- [ ] **Step 3: Add the column and the migration**

In `apps/server/src/db/schema.ts`, inside `export const agents = sqliteTable('agents', { ... })`, add after `credentialHash:`:

```ts
  /** Phase 15: human-facing 9-digit code (ADR-91). Unique via `idx_agents_device_code`. */
  deviceCode: text('device_code'),
```

In `apps/server/src/db/client.ts`:

(a) In the `CREATE TABLE IF NOT EXISTS agents (...)` body, after `credential_hash TEXT UNIQUE,`:

```sql
      device_code TEXT,
```

(b) After the existing `ALTER TABLE agents ADD COLUMN signing_public_key TEXT;` try/catch block, append:

```ts
  // Phase 15: human-facing 9-digit device code (ADR-91). The column is added
  // separately from the unique index because SQLite rejects ADD COLUMN ...
  // UNIQUE on an existing table.
  try {
    sqlite.exec(`
      ALTER TABLE agents ADD COLUMN device_code TEXT;
    `);
  } catch {}
  try {
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_device_code ON agents(device_code);
    `);
  } catch {}
```

(c) At the end of `runMigrations`, after all the try/catch blocks:

```ts
  // Idempotent: finds zero NULL rows on every boot after the first.
  const backfilled = backfillDeviceCodes(sqlite);
  if (backfilled > 0) {
    console.warn(`device_code backfill: assigned ${backfilled} code(s)`);
  }
```

with the import at the top of the file:

```ts
import { backfillDeviceCodes } from '../utils/device-code.js';
```

- [ ] **Step 4: Update the shared contract and the projection**

In `packages/shared/src/types/user.ts`, inside `export interface Agent`, after `signingPublicKey`:

```ts
  /** Human-facing 9-digit device code (ADR-91), or null before allocation. */
  deviceCode: string | null;
```

In `apps/server/src/utils/agent.ts`, inside the `toPublicAgent` object literal, after `signingPublicKey`:

```ts
    deviceCode: agent.deviceCode ?? null,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/server test`
Expected: PASS, including the pre-existing `db.test.ts` and every other server suite.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/client.ts apps/server/src/utils/agent.ts apps/server/src/utils/device-code.ts packages/shared/src/types/user.ts apps/server/test/db.test.ts apps/server/test/device-code.test.ts
git commit -m "feat(server): add device_code column, inline migration, and backfill"
```

**TEST-INTEGRITY:**

| File | Before | After | Reason |
|---|---|---|---|
| `apps/server/test/db.test.ts` | 2 `it()` / 4 `expect()` (re-measure at execution) | +1 `it()`, +3 `expect()` | pins the column and the unique index added by the inline migration |
| `apps/server/test/device-code.test.ts` | 3 `it()` / ~2,000 assertions from Task 2 | +2 `it()`, +5 `expect()` | pins backfill idempotency and the exported normaliser |

---

### Task 4: Registration allocation and dual resolution

**Files:**
- Modify: `apps/server/src/routes/agents.ts` (`POST /`, `GET /:id`)
- Modify: `apps/server/src/routes/sessions.ts` (`resolveOwnedId`, agents call site)
- Test: `apps/server/test/agents-sessions.test.ts` (append only — existing tests untouched)

**Interfaces:**
- Consumes: `generateDeviceCode`, `normalizeDeviceCode`, `DEVICE_CODE_ALLOCATION_ATTEMPTS` (Task 2); `agents.deviceCode` (Task 3).
- Produces: every registered agent carries a code; `POST /api/sessions` and `GET /api/agents/:id` accept a code and return the canonical id.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block to `apps/server/test/agents-sessions.test.ts`, inside the existing top-level `describe('Agents, Devices & Sessions REST API', ...)` (place it after the last existing block, before the closing brace, so the shared `beforeEach`/`afterEach` apply):

```ts
  describe('Device Code resolution (ADR-91)', () => {
    const agentHeaders = () => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    });

    async function createAgent(
      app: ReturnType<typeof createApp>,
      id: string,
    ): Promise<{ id: string; deviceCode: string | null }> {
      const res = await app.request('/api/agents', {
        method: 'POST',
        headers: agentHeaders(),
        body: JSON.stringify({ id, publicKey: 'pk_device_code' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { agent: AgentResponse };
      return body.agent;
    }

    it('returns a nine-digit device code on registration', async () => {
      const app = createApp();
      const agent = await createAgent(app, 'dev_code0001');
      expect(agent.deviceCode).toMatch(/^[1-9]\d{8}$/);
    });

    it('resolves a session from a spaced device code to the canonical agent id', async () => {
      const app = createApp();
      const agent = await createAgent(app, 'dev_code0002');
      const spaced = `${agent.deviceCode!.slice(0, 3)} ${agent.deviceCode!.slice(3, 6)} ${agent.deviceCode!.slice(6)}`;

      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: agentHeaders(),
        body: JSON.stringify({ agentId: spaced }),
      });

      expect(res.status).toBe(201);
      const session = (await res.json()) as SessionResponse;
      expect(session.agentId).toBe(agent.id);
    });

    it.each(['spaced', 'hyphenated', 'padded', 'plain'] as const)(
      'resolves a session from a %s device code',
      async (form) => {
        const app = createApp();
        const agent = await createAgent(app, `dev_form${form.slice(0, 4)}`);
        const digits = agent.deviceCode!;
        const typed =
          form === 'spaced'
            ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`
            : form === 'hyphenated'
              ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
              : form === 'padded'
                ? `  ${digits}  `
                : digits;

        const res = await app.request('/api/sessions', {
          method: 'POST',
          headers: agentHeaders(),
          body: JSON.stringify({ agentId: typed }),
        });

        expect(res.status).toBe(201);
        expect(((await res.json()) as SessionResponse).agentId).toBe(agent.id);
      },
    );

    it('still resolves a legacy dev_ identifier unchanged', async () => {
      const app = createApp();
      const agent = await createAgent(app, 'dev_legacy01');
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: agentHeaders(),
        body: JSON.stringify({ agentId: agent.id }),
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as SessionResponse).agentId).toBe(agent.id);
    });

    it('hides another user’s code behind the same 404 as a missing one', async () => {
      const app = createApp();
      const agent = await createAgent(app, 'dev_mine0001');

      const otherReg = await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'other',
          password: 'Password123!',
          publicKey: 'pk_other',
        }),
      });
      const other = (await otherReg.json()) as AuthResponse;
      const otherHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${other.token}`,
      };

      const foreign = await app.request('/api/sessions', {
        method: 'POST',
        headers: otherHeaders,
        body: JSON.stringify({ agentId: agent.deviceCode }),
      });
      const missing = await app.request('/api/sessions', {
        method: 'POST',
        headers: otherHeaders,
        body: JSON.stringify({ agentId: '111222333' }),
      });

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      const foreignBody = (await foreign.json()) as ErrorResponse;
      const missingBody = (await missing.json()) as ErrorResponse;
      expect(foreignBody.code).toBe('NOT_FOUND');
      expect(foreignBody).toEqual(missingBody);
    });

    it('GET /api/agents/:id resolves a device code to the canonical agent', async () => {
      const app = createApp();
      const agent = await createAgent(app, 'dev_get00001');
      const res = await app.request(`/api/agents/${agent.deviceCode}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as AgentResponse;
      expect(body.id).toBe(agent.id);
    });

    it('GET /api/agents/:id 404s for a non-owner', async () => {
      const app = createApp();
      const agent = await createAgent(app, 'dev_get00002');
      const otherReg = await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'other2',
          password: 'Password123!',
          publicKey: 'pk_other2',
        }),
      });
      const other = (await otherReg.json()) as AuthResponse;
      const res = await app.request(`/api/agents/${agent.deviceCode}`, {
        headers: { Authorization: `Bearer ${other.token}` },
      });
      expect(res.status).toBe(404);
    });
  });
```

Also extend the local `AgentResponse` type near the top of the file (line ~55) with the new field, so the assertions typecheck:

```ts
  deviceCode: string | null;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/server test -- agents-sessions`
Expected: FAIL — `agent.deviceCode` is `null`, and session creation by code returns `404 Agent not found`.

- [ ] **Step 3: Allocate a code on registration**

In `apps/server/src/routes/agents.ts`, add the imports:

```ts
import {
  DEVICE_CODE_ALLOCATION_ATTEMPTS,
  generateDeviceCode,
  normalizeDeviceCode,
} from '../utils/device-code.js';
import type { Database } from '../db/client.js';
```

Add a helper above `router.post('/'`:

```ts
/**
 * Allocate a code that is not already taken.
 *
 * The pre-check is an optimisation; `idx_agents_device_code` is the guarantee.
 * The insert below retries on a unique violation for the same reason.
 */
async function allocateDeviceCode(db: Database): Promise<string> {
  for (let attempt = 0; attempt < DEVICE_CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidate = generateDeviceCode();
    const clash = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.deviceCode, candidate))
      .get();
    if (!clash) return candidate;
  }
  throw new AppError(
    'Failed to allocate a device code',
    500,
    'INTERNAL_SERVER_ERROR',
  );
}
```

Then wrap the insert in a bounded retry. Replace the existing `const [created] = await db.insert(agents)...` block with:

```ts
  let created: typeof agents.$inferSelect | undefined;
  for (let attempt = 0; attempt < DEVICE_CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
    const deviceCode = await allocateDeviceCode(db);
    try {
      [created] = await db
        .insert(agents)
        .values({
          id: body.id,
          userId: user.id,
          hostname: body.hostname ?? null,
          platform: body.platform ?? null,
          osVersion: body.osVersion ?? null,
          agentVersion: body.agentVersion ?? null,
          publicKey,
          isOnline: false,
          credentialHash: await sha256Hex(credential),
          capabilities: body.capabilities
            ? JSON.stringify(body.capabilities)
            : null,
          deviceCode,
        })
        .returning();
      break;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const unique = code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT';
      if (!unique || attempt === DEVICE_CODE_ALLOCATION_ATTEMPTS - 1) throw err;
    }
  }
```

The existing `if (!created) { throw new AppError('Failed to register agent', 500, 'INTERNAL_SERVER_ERROR'); }` block stays exactly as it is.

- [ ] **Step 4: Resolve a code in `GET /api/agents/:id`**

In `apps/server/src/routes/agents.ts`, import the normaliser and rewrite the lookup:

```ts
import { normalizeDeviceCode } from '../utils/device-code.js';
```

```ts
  const agentId = c.req.param('id');
  const normalized = normalizeDeviceCode(agentId);
  const db = c.get('db');

  const agent = await db
    .select()
    .from(agents)
    .where(
      and(
        or(eq(agents.id, agentId), eq(agents.deviceCode, normalized)),
        eq(agents.userId, user.id),
      ),
    )
    .get();
```

Add `or` to the existing `drizzle-orm` import in that file.

- [ ] **Step 5: Make `resolveOwnedId` return the canonical id**

In `apps/server/src/routes/sessions.ts`, replace the function with:

```ts
async function resolveOwnedId<T extends { id: string }>(
  raw: unknown,
  lookup: (
    candidate: string,
    normalized: string,
  ) => T | undefined | Promise<T | undefined>,
  notFoundMessage: string,
): Promise<string | null> {
  if (raw === undefined || raw === null) {
    return null;
  }
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (!candidate) {
    throw new AppError(notFoundMessage, 404, 'NOT_FOUND');
  }
  const normalized = normalizeDeviceCode(candidate);
  const found = await lookup(candidate, normalized);
  if (!found) {
    throw new AppError(notFoundMessage, 404, 'NOT_FOUND');
  }
  return found.id;
}
```

with `import { normalizeDeviceCode } from '../utils/device-code.js';` and `or` added to the `drizzle-orm` import.

**The devices call site is unchanged** — a one-argument arrow is assignable to the two-parameter lookup type:

```ts
  const deviceId = await resolveOwnedId(
    body.deviceId,
    (candidate) =>
      db
        .select()
        .from(devices)
        .where(and(eq(devices.id, candidate), eq(devices.userId, user.id)))
        .get(),
    'Device not found',
  );
```

Its behaviour is identical because `devices.id` is canonical and `found.id === candidate` for every row it can match, so the new `return found.id` yields the same string the old `return candidate` did. Do not add a `device_code` OR clause to the devices lookup, and do not normalise `deviceId`.

The agents call site gains the OR clause:

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

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/server test`
Expected: PASS. The pre-existing device-path tests in `agents-sessions.test.ts` are untouched and green; the new `describe` block is additive.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/agents.ts apps/server/src/routes/sessions.ts apps/server/test/agents-sessions.test.ts
git commit -m "feat(server): allocate device codes on registration and resolve sessions by code"
```

**TEST-INTEGRITY:** `apps/server/test/agents-sessions.test.ts` baseline 29 `it()` / 117 `expect()` is untouched. The appended block adds 7 `it()` declarations (6 `it()` + one `it.each` with 4 rows) and 24 `expect()` calls, measured at execution time and recorded in the task report. `AgentResponse` gains one type field, which is not an assertion.

---

### Task 5: Issue #152 error classification

**Files:**
- Modify: `packages/api-client/src/errors.ts` (`fromResponse` catch branch)
- Test: `packages/api-client/test/client.test.ts` (one declared expectation change)

**Interfaces:**
- Consumes: the standard Web `Response`.
- Produces: non-JSON 5xx → `code: 'SERVER_ERROR'`; non-JSON 4xx → `code: 'API_ERROR'`; a rejected `fetch` stays `NETWORK_ERROR` with status `0` (unchanged, `packages/api-client/src/client.ts`).

- [ ] **Step 1: Change the failing test's expectation**

In `packages/api-client/test/client.test.ts`, replace test 4 (currently at line 69):

```ts
  it('4. Classifies a non-JSON 502 response as SERVER_ERROR', async () => {
    const storage = new MemoryStorage();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<html>Bad Gateway</html>', {
        status: 502,
        statusText: 'Bad Gateway',
      }),
    );
    const client = makeClient(storage, mockFetch);

    await expect(client.users.me()).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: 'SERVER_ERROR',
      message: 'Bad Gateway',
    });
  });

  it('4b. Classifies a non-JSON 404 response as API_ERROR', async () => {
    const storage = new MemoryStorage();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );
    const client = makeClient(storage, mockFetch);

    await expect(client.users.me()).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'API_ERROR',
      message: 'Not Found',
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/api-client test -- client`
Expected: FAIL — test 4 receives `code: 'NETWORK_ERROR'` instead of `'SERVER_ERROR'`.

- [ ] **Step 3: Update the classification**

In `packages/api-client/src/errors.ts`, replace the `catch` branch of `fromResponse`:

```ts
    } catch {
      // A body that is not JSON is not a transport failure: the server answered.
      // A 5xx is the server's own fault, a 4xx is the caller's — `NETWORK_ERROR`
      // is reserved for the branch in `client.ts` where `fetch` itself rejects.
      const isServerError = response.status >= 500 && response.status < 600;
      return new ApiError(
        response.statusText || `HTTP ${response.status}`,
        response.status,
        isServerError ? 'SERVER_ERROR' : 'API_ERROR',
        null,
      );
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/api-client test`
Expected: PASS. The JSON path, the `data.code` path, and the transport `NETWORK_ERROR` path are unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/api-client/src/errors.ts packages/api-client/test/client.test.ts
git commit -m "fix(api-client): classify non-JSON 5xx responses as SERVER_ERROR (#152)"
```

**TEST-INTEGRITY:**

| File | Before | After | Reason |
|---|---|---|---|
| `packages/api-client/test/client.test.ts` | 8 `it()` / 22 `expect()` | 9 `it()` / 23 `expect()` | test 4's expected `code` moves `NETWORK_ERROR` → `SERVER_ERROR` (declared behaviour change, status and message unchanged; the assertion is strictly more specific); the new test 4b pins the 4xx branch, which the spec requires |

---

### Task 6: Desktop main contracts and profile plumbing

**Files:**
- Modify: `apps/desktop/src/shared/ipc-types.ts`
- Modify: `apps/desktop/src/renderer/types.ts`
- Modify: `apps/desktop/src/main/devices.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/config.ts`
- Modify: `apps/desktop/src/main/agent-supervisor.ts`
- Modify: `apps/desktop/src/main/agent-control.ts`
- Test: `apps/desktop/src/main/__tests__/devices.test.ts`
- Test: `apps/desktop/src/main/__tests__/ipc.test.ts`
- Test: `apps/desktop/src/main/__tests__/config.test.ts`
- Test: `apps/desktop/src/main/__tests__/agent-supervisor.test.ts`

**Interfaces:**
- Consumes: `Agent.deviceCode` (Task 3); `normalizeDeviceCode` from `@ponter/shared` (Task 1).
- Produces: `DesktopDevice.deviceCode: string | null`; `AppConfig.deviceCode`; `AppConfig.desktopProfile`; `SupervisorConfig.desktopProfile`; `AGENT_DESKTOP_PROFILE` in the sidecar environment.

**Why `@ponter/shared` is safe here but not on the server:** `apps/desktop/electron.vite.config.ts` lists `@ponter/shared` in `WORKSPACE_PACKAGES` and excludes it from `externalizeDepsPlugin`, so the main and preload bundles inline the TypeScript. The renderer bundles it natively through Vite. Nothing resolves it through Node at runtime.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/main/__tests__/devices.test.ts`, extend the agent fixture in the `listDevices` mapping test with `deviceCode: '749281903'` and assert it:

```ts
      expect(result[0].deviceCode).toBe('749281903');
```

and in the null-fields test assert:

```ts
      expect(result[0].deviceCode).toBeNull();
```

In `apps/desktop/src/main/__tests__/ipc.test.ts`, inside `describe('desktop:open-remote-session', ...)`, append to the valid-URL `it.each` table:

```ts
      {
        description: 'spaced device code',
        serverUrl: 'http://localhost:8787',
        payload: { agentId: '749 281 903' },
        expectedUrl: 'http://localhost:8787/workspace/749281903?mode=desktop',
      },
      {
        description: 'hyphenated device code',
        serverUrl: 'http://localhost:8787',
        payload: { agentId: '749-281-903' },
        expectedUrl: 'http://localhost:8787/workspace/749281903?mode=desktop',
      },
      {
        description: 'legacy agent id preserved',
        serverUrl: 'http://localhost:8787',
        payload: { agentId: 'dev_ab12cd34' },
        expectedUrl:
          'http://localhost:8787/workspace/dev_ab12cd34?mode=desktop',
      },
```

In `apps/desktop/src/main/__tests__/config.test.ts`, append:

```ts
  it('defaults desktopProfile to 1080p30 and persists a valid value', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {});
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
    expect(manager.load().desktopProfile).toBe('1080p30');

    manager.save({ desktopProfile: '1080p60' });
    const written = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1];
    expect(String(written)).toContain('"desktopProfile":"1080p60"');
  });

  it('normalises an unknown persisted desktopProfile to 1080p30', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {});
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ desktopProfile: '1080p' }),
    );
    expect(manager.load().desktopProfile).toBe('1080p30');
  });
```

This file mocks the whole `fs` module, so these tests follow the same `vi.mocked(fs.readFileSync).mockReturnValue(...)` shape the other cases use rather than writing real temp files.

In `apps/desktop/src/main/__tests__/agent-supervisor.test.ts`, append:

```ts
  it('emits AGENT_DESKTOP_PROFILE with the configured value', () => {
    keychainMock.getSecret.mockReturnValue('ag_credential');
    const supervisor = new AgentSupervisor(keychainMock as any);
    const env = supervisor.buildEnvironment({
      agentId: 'dev_aaaaaaaa',
      serverUrl: 'http://localhost:8787',
      allowInput: false,
      desktopProfile: '1080p60',
    });
    expect(env.AGENT_DESKTOP_PROFILE).toBe('1080p60');
  });

  it('emits the safe default when no profile is configured', () => {
    keychainMock.getSecret.mockReturnValue('ag_credential');
    const supervisor = new AgentSupervisor(keychainMock as any);
    const env = supervisor.buildEnvironment({
      agentId: 'dev_aaaaaaaa',
      serverUrl: 'http://localhost:8787',
      allowInput: false,
    });
    expect(env.AGENT_DESKTOP_PROFILE).toBe('1080p30');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/desktop test -- devices.test ipc.test config.test agent-supervisor.test`
Expected: FAIL — `deviceCode` is `undefined`, the spaced code URL-encodes to `749%20281%20903`, and `desktopProfile` / `AGENT_DESKTOP_PROFILE` do not exist.

- [ ] **Step 3: Extend the IPC contract and profile guard**

In `apps/desktop/src/shared/ipc-types.ts`, add above `interface AppConfig`:

```ts
export const DESKTOP_PROFILES = [
  '1080p30',
  '720p30',
  '1080p60',
  '720p60',
] as const;
export type DesktopProfileName = (typeof DESKTOP_PROFILES)[number];
export const DEFAULT_DESKTOP_PROFILE: DesktopProfileName = '1080p30';

/** Any absent, unknown, or non-string value resolves to the safe default. */
export function normalizeDesktopProfile(raw: unknown): DesktopProfileName {
  return typeof raw === 'string' &&
    (DESKTOP_PROFILES as readonly string[]).includes(raw)
    ? (raw as DesktopProfileName)
    : DEFAULT_DESKTOP_PROFILE;
}
```

Add to `AppConfig`:

```ts
  /** This machine's own Device Code, cached so "This Device" reads offline. */
  deviceCode: string | null;
  /** Desktop stream profile forwarded to the sidecar as AGENT_DESKTOP_PROFILE. */
  desktopProfile: DesktopProfileName;
```

Add to `SaveConfigPayload`:

```ts
  /** `undefined` = unchanged, `null` = forget the cached code. */
  deviceCode?: string | null;
  /** `undefined` = unchanged. An invalid value is normalised to 1080p30. */
  desktopProfile?: DesktopProfileName;
```

Add to `interface DesktopDevice` (in the same file), after `signingPublicKey`:

```ts
  deviceCode: string | null;
```

Apply the identical three field additions to `DesktopDevice` (line ~37) and `AppConfig` (line ~63) in `apps/desktop/src/renderer/types.ts`. The renderer keeps its own copy of this contract; a field in only one of the two files is invisible at one layer.

- [ ] **Step 4: Propagate through the two mappers and the config cache**

In `apps/desktop/src/main/devices.ts`, add `deviceCode: agent.deviceCode ?? null,` after `signingPublicKey` in **both** `mapAgentsToDevices()` and `mapAgentToDesktopDevice()`.

In `registerDevice()`, extend the persist call:

```ts
    this.config.save({
      localAgentId: result.agent.id,
      deviceCode: result.agent.deviceCode ?? null,
    });
```

In `listDevices()`, refresh the cache when the local agent is present:

```ts
  async listDevices(): Promise<DesktopDevice[]> {
    const agents = await this.session.retryOnceOn401(() =>
      this.apiClient.agents.list(),
    );
    const devices = this.mapAgentsToDevices(agents);
    const localId = this.config.load().localAgentId;
    const mine = devices.find((device) => device.id === localId);
    if (mine) {
      this.config.save({ deviceCode: mine.deviceCode });
    }
    return devices;
  }
```

In `getLocalAgentId()`, clear the cache when the id is forgotten, using the existing `this.config.save({ localAgentId: null });` call (extend it with `deviceCode: null`). In `deleteDevice()`, where a delete clears `localAgentId`, also clear `deviceCode`.

- [ ] **Step 5: Normalise the IPC URL and plumb the profile**

In `apps/desktop/src/main/ipc.ts`, import the shared helper and normalise:

```ts
import { normalizeDeviceCode } from '@ponter/shared';
```

```ts
      const rawAgentId = normalizeDeviceCode(payload.agentId.trim());
```

Everything after it — the mode whitelist, the URL parse, the protocol check, the subpath preservation, and `shell.openExternal` — is unchanged.

In `apps/desktop/src/main/config.ts`, add `normalizeDesktopProfile` to the existing `../shared/ipc-types` import; in `load()` return:

```ts
      deviceCode:
        typeof persisted.deviceCode === 'string' && persisted.deviceCode
          ? persisted.deviceCode
          : null,
      desktopProfile: normalizeDesktopProfile(persisted.desktopProfile),
```

and in `save()`'s `updated` object:

```ts
      // Phase 15: cache of this machine's own non-secret code (spec §3.3, §5.4).
      deviceCode:
        payload.deviceCode !== undefined
          ? payload.deviceCode
          : persisted.deviceCode ?? null,
      desktopProfile:
        payload.desktopProfile !== undefined
          ? normalizeDesktopProfile(payload.desktopProfile)
          : normalizeDesktopProfile(persisted.desktopProfile),
```

In `apps/desktop/src/main/agent-supervisor.ts`, add to `SupervisorConfig`:

```ts
  desktopProfile?: DesktopProfileName;
```

import the type from `../shared/ipc-types`, and add to the `env` literal in `buildEnvironment()`:

```ts
      AGENT_DESKTOP_PROFILE: config.desktopProfile ?? DEFAULT_DESKTOP_PROFILE,
```

In `apps/desktop/src/main/agent-control.ts`, forward it in `startNow()`:

```ts
      this.deps.supervisor.start({
        agentId,
        serverUrl: cfg.serverUrl ?? '',
        allowInput: cfg.allowInput,
        identityPath: this.deps.identityPath,
        desktopProfile: cfg.desktopProfile,
      });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/desktop typecheck && pnpm --filter @ponter/desktop test`
Expected: PASS. Any test fixture that constructs an `AppConfig` or `DesktopDevice` literal now needs the new required fields; add them with real values (`deviceCode: null`, `desktopProfile: '1080p30'`) rather than weakening an assertion.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/shared/ipc-types.ts apps/desktop/src/renderer/types.ts apps/desktop/src/main/devices.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/config.ts apps/desktop/src/main/agent-supervisor.ts apps/desktop/src/main/agent-control.ts apps/desktop/src/main/__tests__/
git commit -m "feat(desktop): carry deviceCode through the IPC contract and forward the desktop profile"
```

**TEST-INTEGRITY** (re-measured at execution; baselines from the spec's base commit):

| File | Before | After (expected) | Reason |
|---|---|---|---|
| `main/__tests__/devices.test.ts` | 20 `it()` / 41 `expect()` | +0 `it()`, +2 `expect()` | asserts both mappers propagate `deviceCode`, including `null` |
| `main/__tests__/ipc.test.ts` | 23 declarations (20 `it()` + 3 `it.each`) / 53 `expect()` | +3 rows on the existing `it.each` (declaration count unchanged), +0 `expect()` | pins spaced/hyphenated normalisation and legacy preservation |
| `main/__tests__/config.test.ts` | 12 `it()` / 27 `expect()` | +2 `it()`, +4 `expect()` | pins the profile default, round-trip, and invalid-value fallback |
| `main/__tests__/agent-supervisor.test.ts` | 11 `it()` / 27 `expect()` | +1 `it()`, +1 `expect()` | pins `AGENT_DESKTOP_PROFILE` |

---

### Task 7: Desktop renderer — "This Device" and partner input

**Files:**
- Modify: `apps/desktop/src/renderer/views/DevicesView.vue`
- Test: `apps/desktop/src/renderer/__tests__/devices.test.ts`

**Interfaces:**
- Consumes: `DesktopDevice.deviceCode` and `AppConfig.deviceCode` (Task 6); `formatDeviceCode` from `@ponter/shared` (Task 1).
- Produces: `data-testid="this-device-code"`, `data-testid="copy-device-code"`; `this-device-id` retained on the secondary canonical-id line; digit grouping in `remote-agent-id-input`.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/renderer/__tests__/devices.test.ts`:

1. Add `deviceCode: '749281903'` to the `localDevice` fixture used by the mount helper (a required field after Task 6, so the typecheck enforces it).
2. Change the copy test to select `copy-device-code` and expect `writeText('749281903')`.
3. Leave `displays hostname, platform, and the local device ID` asserting `this-device-id` text equals `localDevice.id` — it still holds, because `this-device-id` now sits on the canonical-id line.
4. Append:

```ts
  it('renders this-device-code with grouped digits', async () => {
    const wrapper = await mountView();
    const code = wrapper.find('[data-testid="this-device-code"]');
    expect(code.exists()).toBe(true);
    expect(code.text()).toBe('749 281 903');
  });

  it('renders the placeholder and hides copy when deviceCode is null', async () => {
    const wrapper = await mountView({ localDeviceCode: null });
    expect(
      wrapper.find('[data-testid="this-device-code"]').text(),
    ).toBe('—');
    expect(wrapper.find('[data-testid="copy-device-code"]').exists()).toBe(
      false,
    );
  });

  it('groups partner input digits in threes while typing', async () => {
    const wrapper = await mountView();
    const input = wrapper.find('[data-testid="remote-agent-id-input"]');
    await input.setValue('749281903');
    expect((input.element as HTMLInputElement).value).toBe('749 281 903');
  });

  it('preserves a pasted legacy agent id verbatim', async () => {
    const wrapper = await mountView();
    const input = wrapper.find('[data-testid="remote-agent-id-input"]');
    await input.setValue('dev_ab12cd34');
    expect((input.element as HTMLInputElement).value).toBe('dev_ab12cd34');
  });
```

Rename the file's existing mount helper only if it cannot accept an override; extend it with an optional `{ localDeviceCode?: string | null }` argument instead of duplicating the setup.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/desktop test -- renderer/__tests__/devices`
Expected: FAIL — `this-device-code` does not exist and the input keeps the raw text.

- [ ] **Step 3: Implement the "This Device" card**

In `apps/desktop/src/renderer/views/DevicesView.vue`:

```ts
import { formatDeviceCode } from '@ponter/shared';
```

```ts
const localDeviceCode = computed<string | null>(() => {
  const mine = store.devices.find((d) => d.id === localAgentId.value);
  return mine?.deviceCode ?? localDeviceCodeCache.value ?? null;
});
```

`localDeviceCodeCache` is loaded alongside `localAgentId` in `loadLocalAgentId()` from the config cache (`const cfg = await window.ponter.getConfig(); localDeviceCodeCache.value = cfg.deviceCode ?? null;`). One copy helper serves both surfaces:

```ts
function copyCode(code: string | null) {
  if (!code) return;
  if (navigator?.clipboard?.writeText) {
    void navigator.clipboard.writeText(code);
  }
  copiedId.value = true;
  if (copiedTimer) clearDomTimer(copiedTimer);
  copiedTimer = setDomTimer(() => {
    copiedId.value = false;
  }, 2000);
}
```

Replace the existing "Device ID" block with:

```vue
          <!-- Device Code (primary, copyable as digits only) -->
          <div class="flex items-center gap-2">
            <code
              data-testid="this-device-code"
              class="font-mono text-lg font-bold tracking-wider select-all"
              >{{ formatDeviceCode(localDeviceCode) }}</code
            >
            <Button
              v-if="localDeviceCode"
              data-testid="copy-device-code"
              variant="ghost"
              size="xs"
              class="shrink-0"
              @click="copyCode(localDeviceCode)"
            >
              <Check v-if="copiedId" class="w-3.5 h-3.5 text-emerald-500" />
              <Copy v-else class="w-3.5 h-3.5" />
            </Button>
          </div>
          <!-- Canonical agent id: the key every route, session row, and
               keychain entry uses. Kept visible for support correlation. -->
          <code
            data-testid="this-device-id"
            class="font-mono text-[11px] text-muted-foreground select-all break-all"
            >{{ localAgentId ?? '—' }}</code
          >
```

No `Copy`/`Check` import changes are needed — both are already imported for the existing control.

- [ ] **Step 4: Group digits in the partner input**

Add the formatter:

```ts
/** Digits only, grouped in threes, capped at nine. Non-digit input is trimmed and kept. */
function formatPartnerInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 9);
  if (!digits) return raw.trim();
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ');
}
```

Bind it on the existing input (keep `data-testid` and `v-model`):

```vue
              v-model="remoteAgentId"
              @input="
                remoteAgentId = formatPartnerInput(
                  ($event.target as HTMLInputElement).value,
                )
              "
```

`handleRemoteConnect()` is unchanged: it passes the raw field value, and the IPC handler normalises once (Task 6).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/desktop test -- renderer/__tests__/devices`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/views/DevicesView.vue apps/desktop/src/renderer/__tests__/devices.test.ts
git commit -m "feat(desktop): show the device code on this-device and group partner input digits"
```

**TEST-INTEGRITY** (`apps/desktop/src/renderer/__tests__/devices.test.ts`, baseline 53 `it()` + 1 `it.each` — 54 declarations — / 140 `expect()`, re-measured at execution):

| Test | Before | After | Reason |
|---|---|---|---|
| `displays hostname, platform, and the local device ID` | asserts `this-device-id` text = `localDevice.id` | **unchanged** | the test id was deliberately preserved on the canonical-id line |
| copy test (`copy ID button writes localAgentId…`) | selects `copy-device-id`, expects `writeText(localDevice.id)` | fixture gains `deviceCode`; selects `copy-device-code`; expects `writeText('749281903')` | the copy control now copies the code; declaration and assertion counts unchanged |
| new: `renders this-device-code with grouped digits` | — | +1 `it()`, +2 `expect()` | pins the new primary surface |
| new: `renders the placeholder and hides copy when deviceCode is null` | — | +1 `it()`, +2 `expect()` | pins the offline/backfill gap |
| new: `groups partner input digits in threes while typing` | — | +1 `it()`, +1 `expect()` | pins §3.5.2 |
| new: `preserves a pasted legacy agent id verbatim` | — | +1 `it()`, +1 `expect()` | pins backward compatibility |

---

### Task 8: Web dashboard device code

**Files:**
- Modify: `apps/web/src/views/DashboardView.vue`
- Test: `apps/web/src/__tests__/DashboardView.test.ts`
- Test: `apps/web/src/__tests__/WorkspaceView.test.ts`

**Interfaces:**
- Consumes: `Agent.deviceCode` from the API; `formatDeviceCode` / `normalizeDeviceCode` from `@ponter/shared`.
- Produces: a code line per agent card, a copy control, and a search filter that matches the code with or without spaces.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/__tests__/DashboardView.test.ts`:

```ts
  it('renders the device code in grouped form and the placeholder when absent', async () => {
    const wrapper = await mountDashboard([
      { id: 'dev_a', deviceCode: '749281903', hostname: 'a' },
      { id: 'dev_b', deviceCode: null, hostname: 'b' },
    ]);
    expect(
      wrapper.find('[data-testid="agent-device-code-dev_a"]').text(),
    ).toContain('749 281 903');
    expect(
      wrapper.find('[data-testid="agent-device-code-dev_b"]').text(),
    ).toContain('—');
  });

  it('matches the search query against the device code with and without spaces', async () => {
    const wrapper = await mountDashboard([
      { id: 'dev_a', deviceCode: '749281903', hostname: 'a' },
    ]);
    await wrapper.find('[data-testid="agent-search"]').setValue('749 281');
    expect(wrapper.findAll('[data-testid^="agent-card-"]')).toHaveLength(1);

    await wrapper.find('[data-testid="agent-search"]').setValue('749281');
    expect(wrapper.findAll('[data-testid^="agent-card-"]')).toHaveLength(1);
  });

  it('still launches a shell with the canonical agent id, not the code', async () => {
    const wrapper = await mountDashboard([
      { id: 'dev_a', deviceCode: '749281903', hostname: 'a' },
    ]);
    await wrapper.find('[data-testid="launch-shell-dev_a"]').trigger('click');
    expect(pushMock).toHaveBeenCalledWith({
      name: 'workspace',
      params: { agentId: 'dev_a' },
    });
  });
```

Use the file's existing mount helper and router mock; if the current search input and launch button have no test ids, add `data-testid="agent-search"` and `data-testid="launch-shell-${a.id}"` in Step 3 and keep the assertions as written.

Append to `apps/web/src/__tests__/WorkspaceView.test.ts`:

```ts
  it('opens a tab with a device-code route parameter and passes it to sessions.create', async () => {
    const wrapper = await mountWorkspace('749 281 903');
    expect(terminalStore.openTab).toHaveBeenCalledWith('749 281 903');
    expect(wrapper.exists()).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/web test -- DashboardView.test WorkspaceView.test`
Expected: FAIL — no device-code element, and the search does not match a spaced query.

- [ ] **Step 3: Implement the dashboard surface**

In `apps/web/src/views/DashboardView.vue`, import:

```ts
import { formatDeviceCode, normalizeDeviceCode } from '@ponter/shared';
```

Extend the search predicate in `filteredAgents` (line ~87):

```ts
        normalizeDeviceCode(a.deviceCode ?? '')
          .toLowerCase()
          .includes(normalizeDeviceCode(query))
```

with `const query = searchQuery.value.toLowerCase();` computed once above the predicate, and keep the existing `hostname`, `id`, and `platform` clauses untouched.

Replace the `ID:` block (lines ~477-478) with:

```vue
                      <span>Device Code:</span>
                      <span
                        :data-testid="`agent-device-code-${a.id}`"
                        class="font-mono text-foreground"
                        >{{ formatDeviceCode(a.deviceCode) }}</span
                      >
                      <button
                        v-if="a.deviceCode"
                        :data-testid="`copy-device-code-${a.id}`"
                        class="text-xs text-muted-foreground hover:text-foreground"
                        @click="copyCode(a.deviceCode)"
                      >
                        Copy
                      </button>
```

and add a secondary line beneath it that keeps the canonical id, because every route and session row still uses it:

```vue
                    <div class="flex items-center gap-2 text-xs">
                      <span class="text-muted-foreground">ID:</span>
                      <span class="text-muted-foreground/70 font-mono">{{
                        a.id
                      }}</span>
                    </div>
```

Add a `copyCode` helper mirroring the desktop one (clipboard write plus a short confirmation), and leave the `Launch Shell` router push at `params: { agentId: a.id }` exactly as it is.

`WorkspaceView.vue` needs **no change**: it already reads `route.params.agentId` and passes it to `openTab`, and the server resolves the code in Task 4. The new test pins that the value reaches the store unmodified.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/views/DashboardView.vue apps/web/src/__tests__/DashboardView.test.ts apps/web/src/__tests__/WorkspaceView.test.ts
git commit -m "feat(web): show and search by device code on the dashboard"
```

**TEST-INTEGRITY** (re-measured at execution):

| File | Before | After (expected) | Reason |
|---|---|---|---|
| `DashboardView.test.ts` | 9 `it()` / 23 `expect()` | +3 `it()`, +7 `expect()` | pins rendering, placeholder, search-by-code, and canonical routing |
| `WorkspaceView.test.ts` | 17 `it()` / 32 `expect()` | +1 `it()`, +2 `expect()` | pins that a code route parameter reaches `openTab` unmodified |

---

### Task 9: Docs trail and repo-wide verification

**Files:**
- Modify: `docs/ARCHITECTURE.md` (§8 decision trail)

- [ ] **Step 1: Append the trail entry**

Append one entry to the §8 trail in `docs/ARCHITECTURE.md`, following the existing format, naming ADR-91 and the device-code change once the implementation PR's squash SHA exists. Leave the SHA as the literal `\`(squash SHA in next §8 update)\`` if this task lands before the squash, matching the convention used for PR #115.

- [ ] **Step 2: Run the full gate**

```bash
pnpm format:check
pnpm typecheck
pnpm --filter @ponter/server test
pnpm --filter @ponter/api-client test
pnpm --filter @ponter/shared test
pnpm --filter @ponter/desktop test
pnpm --filter @ponter/web test
```

Expected: every command exits 0.

- [ ] **Step 3: Verify the boot constraint**

```bash
grep -rn "from '@ponter/shared'" apps/server/src/ | grep -v "import type"
```

Expected: no output. A value import here passes typecheck and build and dies at `node apps/server/dist/index.js`.

- [ ] **Step 4: Verify attribution and language**

```bash
git log --format='%an <%ae>%n%b' main..HEAD | grep -i "co-authored-by" || echo "no trailers"
git diff main..HEAD | grep -nP '[\x{1EA0}-\x{1EFF}]' || echo "no Vietnamese characters"
```

Expected: `no trailers` and `no Vietnamese characters`.

- [ ] **Step 5: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: record the device code decision in the architecture trail"
```

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
  // Reject the top partial bucket so the modulo below is unbiased.
  const limit =
    Math.floor(0x1_0000_0000 / DEVICE_CODE_SPACE) * DEVICE_CODE_SPACE;
  let value: number;
  do {
    crypto.getRandomValues(buf);
    // `noUncheckedIndexedAccess` (tsconfig.base.json) types `buf[0]` as
    // `number | undefined`; narrow once into a local so both the loop
    // condition and the modulo are checked.
    value = buf[0]!;
  } while (value >= limit);
  return String(MIN_DEVICE_CODE + (value % DEVICE_CODE_SPACE));
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

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { startServer } from '../src/index.js';
import { getDb, closeDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';

// `startServer` now validates its environment before listening, so the test
// must supply the secrets a real deployment would.
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

/**
 * `startServer` must open the SQLite file named by `DATABASE_PATH`.
 *
 * Regression: `startServer` called `startCleanup(getDb(), …)` with no
 * argument, and `getDb`'s default is `:memory:`. Because `getDb` is a
 * singleton — the first call wins — that eager call seeded an in-memory
 * database before any request arrived, so every later call
 * (`getDb(process.env.DATABASE_PATH)` in the request path) silently reused
 * it. The process ran fine and lost every row on restart: a minted agent
 * credential was gone after the next container restart, and the agent's
 * handshake came back as a bare 401.
 */
describe('startServer database wiring', () => {
  let server: Server | undefined;
  let dir: string | undefined;
  const originalPath = process.env.DATABASE_PATH;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    closeDb();
    if (originalPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = originalPath;
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('opens the file at DATABASE_PATH instead of an in-memory database', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ponter-startup-'));
    const dbPath = join(dir, 'remote.db');
    process.env.DATABASE_PATH = dbPath;
    // Start from a clean singleton: another test in this process may have
    // seeded one already.
    closeDb();

    server = startServer(0);
    await new Promise<void>((resolve) =>
      server!.once('listening', () => resolve()),
    );

    // The eager call in startServer must have created the file.
    expect(existsSync(dbPath)).toBe(true);

    // And the singleton the routes reuse must be that same file-backed
    // instance: a row written through the no-argument accessor survives a
    // close/reopen cycle.
    await getDb()
      .insert(users)
      .values({ id: 'u-startup', username: 'startup', publicKey: 'pk' });
    closeDb();

    const reopened = getDb(dbPath);
    const row = await reopened
      .select()
      .from(users)
      .where(eq(users.id, 'u-startup'))
      .get();
    expect(row?.username).toBe('startup');
  });
});

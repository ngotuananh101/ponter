import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './schema.js';

/**
 * Run Drizzle migrations against the database.
 * Uses drizzle-orm/better-sqlite3/migrator which reads migration files
 * from the given migrations folder.
 */
export function runMigrations(
  db: BetterSQLite3Database<typeof schema>,
  migrationsFolder: string,
): void {
  migrate(db, { migrationsFolder });
}

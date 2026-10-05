import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Database = BetterSQLite3Database<typeof schema>;

// Single instance so closeDb() can close the underlying SQLite connection
let currentDb: Database | undefined;
let currentSqlite: BetterSqlite3.Database | undefined;

function runMigrations(sqlite: BetterSqlite3.Database): void {
  const createTables = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      public_key TEXT NOT NULL,
      signing_public_key TEXT,
      password_hash TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL DEFAULT 'user',
      approval_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_name TEXT,
      device_type TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      is_trusted INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      hostname TEXT,
      platform TEXT,
      os_version TEXT,
      agent_version TEXT,
      public_key TEXT NOT NULL,
      signing_public_key TEXT,
      is_online INTEGER NOT NULL DEFAULT 0,
      last_ping_at TEXT,
      credential_hash TEXT UNIQUE,
      capabilities TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_id TEXT,
      agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS signals_session_created_idx ON signals(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      jti TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      replaced_by_token TEXT,
      replaced_by_expires_at INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `;

  sqlite.exec(createTables);

  // Migration: add role and approval_status columns to existing users tables
  try {
    sqlite.exec(`
      ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
    `);
  } catch {}
  try {
    sqlite.exec(`
      ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending';
    `);
  } catch {}
  // WS2: nullable signing public key for Ed25519 peer identity.
  try {
    sqlite.exec(`
      ALTER TABLE users ADD COLUMN signing_public_key TEXT;
    `);
  } catch {}
  // WS2: nullable signing public key for agent peer identity.
  try {
    sqlite.exec(`
      ALTER TABLE agents ADD COLUMN signing_public_key TEXT;
    `);
  } catch {}
}

/**
 * The path `getDb()` opens when the caller names none.
 *
 * `DATABASE_PATH`, not `:memory:`. `getDb` is a singleton, so the *first* call
 * wins — and the first call is not always a request: `startServer` opens the
 * database before it listens. With a `:memory:` default, an argument-less call
 * there seeded an in-memory database, every later `getDb(DATABASE_PATH)`
 * silently reused it, and the process ran normally while losing every row on
 * restart. A minted agent credential lived only in RAM, so the agent's next
 * handshake after a restart came back as a bare 401.
 *
 * Defaulting to the configured path makes an argument-less call the correct
 * call. A test that wants an in-memory database still passes `':memory:'`
 * explicitly, which every existing fixture already does.
 */
function defaultDbPath(): string {
  return process.env.DATABASE_PATH || ':memory:';
}

export function getDb(dbPath: string = defaultDbPath()): Database {
  // Singleton: if a database instance already exists (e.g. set up by a test
  // fixture or the app bootstrap), reuse it so every request shares the same
  // connection. Pass a different path or call `closeDb()` first to force a new one.
  if (currentDb) {
    return currentDb;
  }

  const sqlite = new BetterSqlite3(dbPath);

  // Configure connection pragmas
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA busy_timeout = 5000;');

  const db = drizzle(sqlite, { schema });

  runMigrations(sqlite);

  currentDb = db;
  currentSqlite = sqlite;
  return db;
}

export function closeDb(): void {
  if (currentSqlite) {
    currentSqlite.close();
    currentSqlite = undefined;
    currentDb = undefined;
  }
}

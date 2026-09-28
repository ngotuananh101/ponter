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
      password_hash TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
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
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS signals_session_created_idx ON signals(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);
  `;

  sqlite.exec(createTables);
}

export function getDb(dbPath: string = ':memory:'): Database {
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

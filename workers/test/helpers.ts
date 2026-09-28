export const TEST_JWT_SECRET = 'jwt-secret-min-32-chars-for-test-suit';

/**
 * `D1Database.exec()` splits its input on newlines, so a multi-line
 * `CREATE TABLE` is torn apart mid-statement. `D1Database.batch()` takes one
 * prepared statement per array entry, keeping each statement's exact
 * multi-line SQL while still running them sequentially and atomically.
 *
 * This fixture creates all tables defined in `src/db/schema.ts`.
 */
export const RESET_STATEMENTS = [
  'PRAGMA foreign_keys = ON',
  'DROP TABLE IF EXISTS signals',
  'DROP TABLE IF EXISTS audit_logs',
  'DROP TABLE IF EXISTS sessions',
  'DROP TABLE IF EXISTS agents',
  'DROP TABLE IF EXISTS devices',
  'DROP TABLE IF EXISTS users',
  `CREATE TABLE users (
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
  )`,
  `CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT,
    device_type TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    is_trusted INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `-- NOTE: inline UNIQUE is deliberate. The 0002 migration cannot use this form
  -- (ALTER TABLE ADD COLUMN rejects it); it creates agents_credential_hash_unique
  -- as a separate index instead. Both admit many NULLs. Do not "converge" them.
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hostname TEXT,
    platform TEXT,
    os_version TEXT,
    agent_version TEXT,
    public_key TEXT NOT NULL,
    is_online INTEGER NOT NULL DEFAULT 0,
    last_ping_at TEXT,
    credential_hash TEXT UNIQUE,
    capabilities TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT REFERENCES devices(id),
    agent_id TEXT REFERENCES agents(id),
    status TEXT NOT NULL DEFAULT 'pending',
    started_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    metadata TEXT
  )`,
  `CREATE TABLE signals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
  )`,
  `CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    user_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    details TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

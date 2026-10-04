import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  username: text('username').notNull().unique(),
  email: text('email').unique(),
  publicKey: text('public_key').notNull(),
  passwordHash: text('password_hash'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  role: text('role').notNull().default('user'),
  approvalStatus: text('approval_status').notNull().default('pending'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  lastLoginAt: text('last_login_at'),
  metadata: text('metadata'),
});

export const devices = sqliteTable('devices', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  deviceName: text('device_name'),
  deviceType: text('device_type').notNull(),
  fingerprint: text('fingerprint').notNull().unique(),
  isTrusted: integer('is_trusted', { mode: 'boolean' })
    .notNull()
    .default(false),
  lastSeenAt: text('last_seen_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  hostname: text('hostname'),
  platform: text('platform'),
  osVersion: text('os_version'),
  agentVersion: text('agent_version'),
  publicKey: text('public_key').notNull(),
  isOnline: integer('is_online', { mode: 'boolean' }).notNull().default(false),
  lastPingAt: text('last_ping_at'),
  credentialHash: text('credential_hash'),
  capabilities: text('capabilities'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const sessions = sqliteTable('sessions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').references(() => devices.id, {
    onDelete: 'set null',
  }),
  agentId: text('agent_id').references(() => agents.id, {
    onDelete: 'set null',
  }),
  status: text('status').notNull().default('pending'),
  startedAt: text('started_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  endedAt: text('ended_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const signals = sqliteTable(
  'signals',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: text('payload').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    // TTL column for signal expiry; nullable for backward compatibility with
    // existing rows that have no expiry set.
    expiresAt: text('expires_at'),
  },
  (table) => [
    index('signals_session_created_idx').on(table.sessionId, table.createdAt),
  ],
);

export const revokedTokens = sqliteTable(
  'revoked_tokens',
  {
    jti: text('jti').primaryKey(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_revoked_tokens_expires').on(table.expiresAt)],
);

export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export type UserSelect = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type DeviceSelect = typeof devices.$inferSelect;
export type AgentSelect = typeof agents.$inferSelect;
export type SessionSelect = typeof sessions.$inferSelect;
export type SignalSelect = typeof signals.$inferSelect;

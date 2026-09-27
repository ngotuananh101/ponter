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
  deviceType: text('device_type').notNull(), // 'desktop' | 'mobile' | 'web'
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
  credentialHash: text('credential_hash').unique(),
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
  deviceId: text('device_id').references(() => devices.id),
  agentId: text('agent_id').references(() => agents.id),
  status: text('status').notNull().default('pending'),
  startedAt: text('started_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  endedAt: text('ended_at'),
  metadata: text('metadata'),
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
    type: text('type').notNull(), // 'offer' | 'answer' | 'ice-candidate'
    payload: text('payload').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    expiresAt: text('expires_at'),
  },
  (table) => [
    index('signals_session_created_idx').on(table.sessionId, table.createdAt),
    index('signals_expires_at_idx').on(table.expiresAt),
  ],
);

export const auditLogs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id'),
  action: text('action').notNull(),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  details: text('details'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export type UserSelect = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type DeviceSelect = typeof devices.$inferSelect;
export type AgentSelect = typeof agents.$inferSelect;
export type SessionSelect = typeof sessions.$inferSelect;
export type SignalSelect = typeof signals.$inferSelect;

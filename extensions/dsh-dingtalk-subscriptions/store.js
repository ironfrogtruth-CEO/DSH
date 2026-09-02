import { createRequire } from 'node:module'
import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
let DatabaseSync
try {
  ({ DatabaseSync } = require('node:sqlite'))
} catch {
  DatabaseSync = null
}

export const DEFAULT_DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const DEFAULT_PRIVATE_ROOT = join(DEFAULT_DSH_HOME, 'private', 'dingtalk-subscriptions')
export const DEFAULT_DB_PATH = join(DEFAULT_PRIVATE_ROOT, 'subscriptions.sqlite')
export const SQLITE_SCHEMA_VERSION = 1

export class SubscriptionStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'SubscriptionStoreError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function plain(row) {
  if (!row) return null
  return Object.fromEntries(Object.entries(row))
}

export function jsonText(value, fallback = {}) {
  if (value === undefined || value === null) return JSON.stringify(fallback)
  try {
    const text = JSON.stringify(value)
    if (text.length > 512_000) throw new SubscriptionStoreError('PAYLOAD_TOO_LARGE', '订阅数据过大')
    return text
  } catch (error) {
    if (error instanceof SubscriptionStoreError) throw error
    throw new SubscriptionStoreError('PAYLOAD_INVALID', `订阅数据不可序列化: ${error.message}`)
  }
}

export function parseJson(value, fallback = {}) {
  if (typeof value !== 'string' || !value) return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

export function ensurePrivateRoot(root = DEFAULT_PRIVATE_ROOT) {
  if (root === ':memory:') return root
  mkdirSync(root, { recursive: true, mode: 0o700 })
  try { chmodSync(root, 0o700) } catch { /* the open below will report a real failure */ }
  return root
}

export function ensurePrivateFileMode(path, mode = 0o600) {
  if (path === ':memory:') return
  try { chmodSync(path, mode) } catch (error) {
    throw new SubscriptionStoreError('PRIVATE_FILE_MODE_FAILED', `无法设置私有文件权限: ${error.message}`)
  }
}

export function defaultDbPath(value = undefined) {
  const configured = String(value ?? process.env.DSH_DINGTALK_SUBSCRIPTIONS_DB ?? '').trim()
  if (!configured) return DEFAULT_DB_PATH
  if (configured === ':memory:') return configured
  if (/^(?:file:|https?:)/iu.test(configured)) throw new SubscriptionStoreError('DB_PATH_INVALID', '订阅数据库只接受本地文件路径')
  return configured
}

function createSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscribers (
      subscriber_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      identity_hmac TEXT UNIQUE,
      identity_hmac_algo TEXT NOT NULL DEFAULT 'hmac-sha256',
      weekly_token_limit INTEGER NOT NULL DEFAULT 0 CHECK (weekly_token_limit >= 0),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS robot_accounts (
      account_id TEXT PRIMARY KEY,
      subscriber_id TEXT NOT NULL UNIQUE REFERENCES subscribers(subscriber_id) ON DELETE RESTRICT,
      credential_ref TEXT NOT NULL,
      robot_code TEXT,
      robot_name TEXT NOT NULL DEFAULT '大神',
      robot_description TEXT NOT NULL DEFAULT '大神｜Visible Workflow. Reliable Intelligence.',
      avatar_sha256 TEXT,
      brand_status TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending',
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS robot_accounts_status ON robot_accounts(status, subscriber_id);

    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT PRIMARY KEY,
      subscriber_id TEXT NOT NULL REFERENCES subscribers(subscriber_id) ON DELETE RESTRICT,
      display_name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(subscriber_id, root_path)
    );
    CREATE INDEX IF NOT EXISTS workspaces_subscriber ON workspaces(subscriber_id, status);

    CREATE TABLE IF NOT EXISTS entitlements (
      entitlement_id TEXT PRIMARY KEY,
      subscriber_id TEXT NOT NULL REFERENCES subscribers(subscriber_id) ON DELETE RESTRICT,
      kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(subscriber_id, kind, resource_id)
    );
    CREATE INDEX IF NOT EXISTS entitlements_lookup ON entitlements(subscriber_id, kind, status);

    CREATE TABLE IF NOT EXISTS selections (
      subscriber_id TEXT PRIMARY KEY REFERENCES subscribers(subscriber_id) ON DELETE CASCADE,
      mode_id TEXT,
      workspace_id TEXT,
      model_provider TEXT,
      model_id TEXT,
      effort_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quota_cycles (
      cycle_id TEXT PRIMARY KEY,
      subscriber_id TEXT NOT NULL REFERENCES subscribers(subscriber_id) ON DELETE RESTRICT,
      period_key TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      limit_tokens INTEGER NOT NULL CHECK (limit_tokens >= 0),
      used_tokens INTEGER NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
      reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(subscriber_id, period_key, generation)
    );
    CREATE INDEX IF NOT EXISTS quota_cycles_current ON quota_cycles(subscriber_id, period_key, generation DESC);

    CREATE TABLE IF NOT EXISTS quota_reservations (
      reservation_id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL REFERENCES quota_cycles(cycle_id) ON DELETE RESTRICT,
      subscriber_id TEXT NOT NULL REFERENCES subscribers(subscriber_id) ON DELETE RESTRICT,
      amount_tokens INTEGER NOT NULL CHECK (amount_tokens > 0),
      actual_tokens INTEGER,
      state TEXT NOT NULL DEFAULT 'reserved',
      idempotency_key TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(subscriber_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS quota_reservations_state ON quota_reservations(subscriber_id, state, created_at);

    CREATE TABLE IF NOT EXISTS session_lineage (
      session_id TEXT PRIMARY KEY,
      subscriber_id TEXT NOT NULL REFERENCES subscribers(subscriber_id) ON DELETE RESTRICT,
      account_id TEXT NOT NULL REFERENCES robot_accounts(account_id) ON DELETE RESTRICT,
      agent_id TEXT,
      parent_session_id TEXT,
      kind TEXT NOT NULL DEFAULT 'main',
      status TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_lineage_agent ON session_lineage(agent_id, subscriber_id);
    CREATE INDEX IF NOT EXISTS session_lineage_subscriber ON session_lineage(subscriber_id, status);

    CREATE TABLE IF NOT EXISTS holiday_calendars (
      year INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_title TEXT NOT NULL DEFAULT '',
      source_checksum TEXT NOT NULL,
      workdays_json TEXT NOT NULL DEFAULT '[]',
      restdays_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      action TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      actor_id_hmac TEXT,
      subscriber_id TEXT,
      outcome TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_events_subscriber ON audit_events(subscriber_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_events_action ON audit_events(action, created_at DESC);

    CREATE TABLE IF NOT EXISTS binding_challenges (
      challenge_id TEXT PRIMARY KEY,
      subscriber_id TEXT NOT NULL REFERENCES subscribers(subscriber_id) ON DELETE RESTRICT,
      account_id TEXT REFERENCES robot_accounts(account_id) ON DELETE RESTRICT,
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS binding_challenges_active ON binding_challenges(subscriber_id, status, expires_at);

    CREATE TABLE IF NOT EXISTS outbox (
      outbox_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      aggregate_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, next_attempt_at, created_at);

    CREATE TABLE IF NOT EXISTS shrimp_invocation_receipts (
      receipt_id TEXT PRIMARY KEY,
      subscriber_id TEXT NOT NULL REFERENCES subscribers(subscriber_id) ON DELETE RESTRICT,
      session_scope TEXT NOT NULL,
      message_id TEXT,
      resource_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1 AND max_uses <= 10),
      uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shrimp_invocation_receipts_scope ON shrimp_invocation_receipts(subscriber_id, session_scope, status, expires_at);
  `)
}

export class SubscriptionStore {
  constructor(options = {}) {
    if (!DatabaseSync) throw new SubscriptionStoreError('SQLITE_UNAVAILABLE', '订阅服务要求 Node 内置 node:sqlite；不提供 JSON 回退')
    this.path = defaultDbPath(options.dbPath || (options.privateRoot ? join(options.privateRoot, 'subscriptions.sqlite') : undefined))
    this.dbPath = this.path
    this.backend = 'sqlite'
    if (this.path !== ':memory:') {
      const parent = dirname(this.path)
      mkdirSync(parent, { recursive: true, mode: 0o700 })
      if (!options.dbPath || this.path === DEFAULT_DB_PATH || options.privateRoot) ensurePrivateRoot(options.privateRoot || parent)
      // SQLite creates the file during open.  The explicit mode is reapplied
      // afterwards for an existing file and for newly-created databases.
    }
    try {
      this.db = new DatabaseSync(this.path)
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
      const journal = this.db.prepare('PRAGMA journal_mode = WAL').get()
      const journalMode = String(journal?.journal_mode || '').toLowerCase()
      if (this.path !== ':memory:' && journalMode !== 'wal') {
        this.db.close()
        throw new SubscriptionStoreError('SQLITE_WAL_REQUIRED', `订阅数据库未启用 WAL（当前: ${journalMode || 'unknown'}）`)
      }
      this.db.exec('PRAGMA synchronous = NORMAL;')
      createSchema(this.db)
      if (this.path !== ':memory:') ensurePrivateFileMode(this.path, 0o600)
      this.db.prepare(`INSERT INTO schema_meta(key,value,updated_at) VALUES ('schema_version',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(String(SQLITE_SCHEMA_VERSION), new Date().toISOString())
    } catch (error) {
      try { this.db?.close() } catch { /* ignore */ }
      if (error instanceof SubscriptionStoreError) throw error
      throw new SubscriptionStoreError('SQLITE_OPEN_FAILED', `无法打开订阅数据库: ${error.message}`, { path: this.path })
    }
  }

  close() {
    try { this.db?.close() } finally { this.db = null }
  }

  exec(sql) { return this.db.exec(sql) }

  get(sql, ...params) { return plain(this.db.prepare(sql).get(...params)) }

  all(sql, ...params) { return this.db.prepare(sql).all(...params).map(plain) }

  run(sql, ...params) { return this.db.prepare(sql).run(...params) }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback(this)
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve original failure */ }
      throw error
    }
  }

  pragma(name) {
    const allowed = new Set(['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout'])
    const key = String(name || '').toLowerCase()
    if (!allowed.has(key)) throw new SubscriptionStoreError('PRAGMA_FORBIDDEN', '不允许读取该 SQLite pragma')
    return this.get(`PRAGMA ${key}`)
  }
}

export function createSubscriptionStore(options = {}) {
  return new SubscriptionStore(options)
}

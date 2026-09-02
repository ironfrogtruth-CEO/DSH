import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { SubscriptionStore, SubscriptionStoreError, DEFAULT_DB_PATH, DEFAULT_PRIVATE_ROOT, defaultDbPath, ensurePrivateRoot, ensurePrivateFileMode, jsonText, parseJson } from './store.js'
import { SHANGHAI_TIME_ZONE, DEFAULT_HOLIDAY_CALENDARS, addDays, calendarChecksum, dateKey, defaultCalendar, isAllowedWorkdayFromCalendar, mondayOfWeek, nextWeekStart, normalizeHolidayCalendar, workdayInfo } from './calendar.js'
import { SUBSCRIBER_PROTECTED_RESPONSE, SUBSCRIBER_SHRIMP_RESPONSE, createSubscriberPreExecuteListener, detectProtectedContentDisclosure, evaluateSubscriberToolCall, classifyProtectedContentRequest, workspacePathDecision } from './policy.js'
import { BRAND_ASSET_PATH, BRAND_MANIFEST_PATH, BRAND_AVATAR_SHA256, BRAND_ASSET, brandAssetSha256, verifyBrandAsset } from './brand.js'
import { ShrimpTankSubscriberClient } from './shrimp-client.js'

export const name = 'dsh-dingtalk-subscriptions'
export const inject = ['webServer', 'credentials']
export const ADMIN_API_PATH = '/api/dsh-dingtalk/subscriptions/admin'
export const STATUS_API_PATH = '/api/dsh-dingtalk/subscriptions/status'
export const BRAND_AVATAR_API_PATH = '/api/dsh-dingtalk/subscriptions/brand-avatar.png'
export const ADMIN_TOKEN_HEADER = 'X-Dashen-Native-Admin'
export const SUBSCRIBER_ASSERTION_HEADER = 'X-DSH-Subscriber-Assertion'
export const SUBSCRIBER_SIGNATURE_HEADER = 'X-DSH-Subscriber-Signature'
export const BRAND_NAME = '大神'
export const BRAND_DESCRIPTION = '大神｜Visible Workflow. Reliable Intelligence.'
export const DEFAULT_WORKSPACE_FOLDER = '大神订阅工作区'
export const SUBSCRIBER_SHRIMP_DENIAL = SUBSCRIBER_SHRIMP_RESPONSE
export const DEFAULT_METERED_PROVIDERS = Object.freeze(['deepseek-official', 'zhipu-glm'])
export const EFFORT_DISPLAY_NAMES = Object.freeze({ off: '关闭推理', low: '低', medium: '中', high: '高', max: '最高' })

export const SUBSCRIBER_STATUSES = Object.freeze({
  PENDING: 'pending',
  WAITING_ROBOT: 'waiting_robot',
  WAITING_BINDING: 'waiting_binding',
  WAITING_WORKSPACE: 'waiting_workspace',
  WAITING_CONFIGURATION: 'waiting_configuration',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  REVOKED: 'revoked',
  QUOTA_EXHAUSTED: 'quota_exhausted',
})
export const ENTITLEMENT_KINDS = Object.freeze(['mode', 'workspace', 'model', 'effort', 'shrimp'])
export const QUOTA_STATES = Object.freeze({ RESERVED: 'reserved', SETTLED: 'settled', RELEASED: 'released' })
export const BRAND = Object.freeze({ name: BRAND_NAME, description: BRAND_DESCRIPTION, avatarSha256: BRAND_AVATAR_SHA256, avatarPath: BRAND_ASSET_PATH, avatarWidth: 512, avatarHeight: 512, transparent: true, borderless: true, shadow: false, text: false })
export const SUBSCRIBER_SAFE_SCOPES = Object.freeze(['pipeline:run', 'run:read', 'artifact:read', 'subscriber:status', 'quota:read'])
export { BRAND_ASSET_PATH, BRAND_MANIFEST_PATH, BRAND_AVATAR_SHA256, BRAND_ASSET, brandAssetSha256, verifyBrandAsset }

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u
const STAFF_RE = /^[^\u0000\r\n]{1,512}$/u
const ROLE_SYSTEM_OWNER = 'system_owner'
const ROLE_SUBSCRIBER = 'subscriber'
const DEFAULT_ASSERTION_TTL_MS = 5 * 60 * 1_000
const MAX_ASSERTION_TTL_MS = 10 * 60 * 1_000

export class SubscriptionError extends Error {
  constructor(code, message, details = undefined, status = undefined) {
    super(message)
    this.name = 'SubscriptionError'
    this.code = code
    if (details !== undefined) this.details = details
    if (status !== undefined) this.status = status
  }
}

function text(value, label, max = 2_000) {
  const result = String(value ?? '').normalize('NFKC').trim()
  if (!result || result.length > max) throw new SubscriptionError('INVALID_INPUT', `${label || '文本'}无效`)
  return result
}

function optionalText(value, max = 2_000) {
  if (value === undefined || value === null || value === '') return null
  const result = String(value).normalize('NFKC').trim()
  return result ? result.slice(0, max) : null
}

function literalText(value, label, max = 2_000) {
  const result = String(value ?? '').trim()
  if (!result || result.length > max) throw new SubscriptionError('INVALID_INPUT', `${label || '文本'}无效`)
  return result
}

function id(value, label = '标识') {
  const result = text(value, label, 200)
  if (!ID_RE.test(result)) throw new SubscriptionError('INVALID_ID', `${label}格式无效`)
  return result
}

function nowIso(clock) {
  const value = typeof clock === 'function' ? clock() : clock
  const date = value instanceof Date ? value : new Date(value || Date.now())
  if (Number.isNaN(date.getTime())) throw new SubscriptionError('INVALID_TIME', '时间无效')
  return date.toISOString()
}

function number(value, label, { integer = true, min = 0, max = Number.MAX_SAFE_INTEGER, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return null
    throw new SubscriptionError('INVALID_NUMBER', `${label}必须是数字`)
  }
  const result = Number(value)
  if (!Number.isFinite(result) || (integer && !Number.isInteger(result)) || result < min || result > max) {
    throw new SubscriptionError('INVALID_NUMBER', `${label}超出允许范围`)
  }
  return integer ? Math.trunc(result) : result
}

function boolInt(value) { return value ? 1 : 0 }

function parseModel(value, provider = undefined) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const resolvedProvider = text(value.provider ?? provider, '模型 provider', 200)
    const resolvedModel = text(value.model ?? value.id ?? value.modelId, '模型名称', 200)
    return { provider: resolvedProvider, model: resolvedModel, resourceId: `${resolvedProvider}/${resolvedModel}` }
  }
  const raw = text(value, '模型', 400)
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) throw new SubscriptionError('INVALID_MODEL', '模型必须使用 provider/model 格式')
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1), resourceId: raw }
}

function parseEntitlementKind(value) {
  const kind = text(value, '授权类型', 40).toLowerCase()
  const aliases = { preset: 'mode', operation_mode: 'mode', reasoning: 'effort', reasoning_effort: 'effort', shrimp_run: 'shrimp' }
  const normalized = aliases[kind] || kind
  if (!ENTITLEMENT_KINDS.includes(normalized)) throw new SubscriptionError('ENTITLEMENT_KIND_INVALID', '不支持的授权类型')
  return normalized
}

function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

function fromBase64url(value) {
  return Buffer.from(String(value), 'base64url')
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function encodeSubscriberAssertionClaims(claims) {
  return base64url(canonicalJson(claims))
}

export function signSubscriberAssertionClaims(claims, secret) {
  if (!secret || (typeof secret !== 'string' && !Buffer.isBuffer(secret))) throw new SubscriptionError('IDENTITY_SECRET_MISSING', '订阅身份 HMAC secret 未配置')
  const encoded = encodeSubscriberAssertionClaims(claims)
  return { encoded, signature: createHmac('sha256', secret).update(encoded, 'utf8').digest('hex') }
}

function constantTimeHexEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function sanitizeMetadata(value) {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SubscriptionError('METADATA_INVALID', 'metadata 必须是对象')
  const secretKey = /^(?:client[_-]?secret|secret|password|passphrase|token|access[_-]?token|api[_-]?key|authorization|cookie|private[_-]?key)$/iu
  const secretValue = /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|private[_-]?key|secret|authorization)\s*[:=]\s*\S+/iu
  const visit = (item, depth = 0) => {
    if (depth > 8 || item === null || item === undefined) return
    if (typeof item === 'string') { if (secretValue.test(item)) throw new SubscriptionError('SECRET_METADATA_FORBIDDEN', 'metadata 不得包含密钥或令牌') ; return }
    if (Array.isArray(item)) { item.forEach((child) => visit(child, depth + 1)); return }
    if (typeof item !== 'object') return
    for (const [key, child] of Object.entries(item)) {
      if (secretKey.test(key)) throw new SubscriptionError('SECRET_METADATA_FORBIDDEN', 'metadata 不得包含密钥或令牌')
      visit(child, depth + 1)
    }
  }
  visit(value)
  return value
}

function usageMeteredFlag(value) {
  return value === true || value?.usageMetered === true || value?.usage_metered === true || value?.usage?.reliable === true || value?.usage?.metered === true || value?.capabilities?.usageMetered === true
}

export function usageFromValue(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value
  const source = value && typeof value === 'object' ? value.usage || value.usageStats || value.tokenUsage || value : {}
  const keys = ['totalTokens', 'total_tokens', 'tokens', 'usageTokens', 'usage_tokens']
  for (const key of keys) {
    if (source[key] !== undefined) {
      const total = Number(source[key])
      if (Number.isSafeInteger(total) && total >= 0) return total
    }
  }
  const firstNumber = (names) => {
    for (const key of names) {
      if (source[key] === undefined || source[key] === null) continue
      const item = Number(source[key])
      if (Number.isSafeInteger(item) && item >= 0) return item
      return null
    }
    return undefined
  }
  const uncachedInput = firstNumber(['uncachedInputTokens', 'uncached_input_tokens', 'promptCacheMissTokens', 'prompt_cache_miss_tokens', 'cacheMissTokens', 'cache_miss_tokens'])
  const input = firstNumber(['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'])
  const output = firstNumber(['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'])
  const cacheRead = firstNumber(['cacheReadTokens', 'cache_read_tokens', 'promptCacheHitTokens', 'prompt_cache_hit_tokens', 'cache_read'])
  const cacheWrite = firstNumber(['cacheWriteTokens', 'cache_write_tokens', 'cache_write'])
  // Some providers report reasoning separately while output already includes
  // it.  Only use the reasoning field when no output total is available.
  const reasoning = output === undefined ? firstNumber(['reasoningTokens', 'reasoning_tokens']) : 0
  // Provider totals commonly already include cache reads/writes. Prefer a
  // disjoint uncached-input breakdown when one exists; otherwise use the
  // provider's input total and do not add its cache detail fields again.
  const inputParts = uncachedInput !== undefined
    ? [uncachedInput, cacheRead, cacheWrite]
    : input !== undefined
      ? [input]
      : [cacheRead, cacheWrite]
  const values = [...inputParts, output, reasoning].filter((item) => item !== undefined)
  if (!values.length || values.some((item) => item === null)) return null
  return values.reduce((sum, item) => sum + item, 0)
}

function rowMetadata(row) { return parseJson(row?.metadata_json, {}) }

function mapSubscriber(row) {
  if (!row) return null
  return {
    subscriberId: row.subscriber_id,
    displayName: row.display_name,
    status: row.status,
    identityBound: Boolean(row.identity_hmac),
    weeklyTokenLimit: Number(row.weekly_token_limit || 0),
    revision: Number(row.revision || 1),
    metadata: rowMetadata(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapRobot(row) {
  if (!row) return null
  return {
    accountId: row.account_id,
    subscriberId: row.subscriber_id,
    credentialRef: row.credential_ref,
    robotCode: row.robot_code || null,
    robotName: row.robot_name,
    robotDescription: row.robot_description,
    avatarSha256: row.avatar_sha256 || null,
    brandStatus: row.brand_status,
    status: row.status,
    revision: Number(row.revision || 1),
    metadata: rowMetadata(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapWorkspace(row) {
  if (!row) return null
  return {
    workspaceId: row.workspace_id,
    subscriberId: row.subscriber_id,
    displayName: row.display_name,
    rootPath: row.root_path,
    status: row.status,
    metadata: rowMetadata(row),
    revision: Number(row.revision || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapEntitlement(row) {
  if (!row) return null
  return {
    entitlementId: row.entitlement_id,
    subscriberId: row.subscriber_id,
    kind: row.kind,
    resourceId: row.resource_id,
    displayName: row.display_name,
    provider: row.provider || null,
    model: row.model || null,
    status: row.status,
    metadata: rowMetadata(row),
    revision: Number(row.revision || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapSelection(row) {
  if (!row) return null
  return {
    subscriberId: row.subscriber_id,
    modeId: row.mode_id || null,
    workspaceId: row.workspace_id || null,
    modelProvider: row.model_provider || null,
    modelId: row.model_id || null,
    effortId: row.effort_id || null,
    revision: Number(row.revision || 1),
    updatedAt: row.updated_at,
  }
}

function mapCycle(row) {
  if (!row) return null
  const limit = Number(row.limit_tokens || 0)
  const used = Number(row.used_tokens || 0)
  const reserved = Number(row.reserved_tokens || 0)
  return {
    cycleId: row.cycle_id,
    subscriberId: row.subscriber_id,
    periodKey: row.period_key,
    generation: Number(row.generation || 0),
    periodStart: row.period_start,
    periodEnd: row.period_end,
    limitTokens: limit,
    usedTokens: used,
    reservedTokens: reserved,
    remainingTokens: Math.max(0, limit - used - reserved),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapReservation(row) {
  if (!row) return null
  return {
    reservationId: row.reservation_id,
    cycleId: row.cycle_id,
    subscriberId: row.subscriber_id,
    amountTokens: Number(row.amount_tokens || 0),
    actualTokens: row.actual_tokens === null || row.actual_tokens === undefined ? null : Number(row.actual_tokens),
    state: row.state,
    idempotencyKey: row.idempotency_key || null,
    metadata: rowMetadata(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapLineage(row) {
  if (!row) return null
  return {
    sessionId: row.session_id,
    subscriberId: row.subscriber_id,
    accountId: row.account_id,
    agentId: row.agent_id || null,
    parentSessionId: row.parent_session_id || null,
    kind: row.kind,
    status: row.status,
    metadata: rowMetadata(row),
    revision: Number(row.revision || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapCalendar(row) {
  if (!row) return null
  return {
    year: Number(row.year),
    timezone: row.timezone,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    sourceChecksum: row.source_checksum,
    workingDays: parseJson(row.workdays_json, []),
    restDays: parseJson(row.restdays_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapAudit(row) {
  if (!row) return null
  return {
    auditId: Number(row.audit_id),
    eventId: row.event_id,
    action: row.action,
    actorRole: row.actor_role,
    actorIdHmac: row.actor_id_hmac || null,
    subscriberId: row.subscriber_id || null,
    outcome: row.outcome,
    details: parseJson(row.details_json, {}),
    createdAt: row.created_at,
  }
}

function mapChallenge(row) {
  if (!row) return null
  return {
    challengeId: row.challenge_id,
    subscriberId: row.subscriber_id,
    accountId: row.account_id || null,
    status: row.status,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at || null,
    metadata: rowMetadata(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapOutbox(row) {
  if (!row) return null
  return {
    outboxId: row.outbox_id,
    kind: row.kind,
    aggregateId: row.aggregate_id || null,
    idempotencyKey: row.idempotency_key,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    attempts: Number(row.attempts || 0),
    nextAttemptAt: row.next_attempt_at || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapShrimpReceipt(row) {
  if (!row) return null
  return {
    receiptId: row.receipt_id,
    subscriberId: row.subscriber_id,
    sessionScope: row.session_scope,
    messageId: row.message_id || null,
    resourceId: row.resource_id,
    displayName: row.display_name,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    maxUses: Number(row.max_uses || 1),
    uses: Number(row.uses || 0),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function defaultNativeAdminTokenPath(privateRoot = DEFAULT_PRIVATE_ROOT) {
  return join(privateRoot, 'native-admin-token')
}

export function ensureNativeAdminToken(path = defaultNativeAdminTokenPath()) {
  if (path === ':memory:') return randomBytes(32).toString('base64url')
  ensurePrivateRoot(dirname(path))
  let token = ''
  try { token = readFileSync(path, 'utf8').trim() } catch (error) {
    if (error?.code !== 'ENOENT') throw new SubscriptionError('ADMIN_TOKEN_READ_FAILED', `无法读取原生管理员令牌: ${error.message}`)
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
    token = randomBytes(32).toString('base64url')
    let fd
    try {
      fd = openSync(path, 'wx', 0o600)
      writeFileSync(fd, `${token}\n`, 'utf8')
    } catch (error) {
      if (error?.code === 'EEXIST') {
        token = readFileSync(path, 'utf8').trim()
      } else {
        throw new SubscriptionError('ADMIN_TOKEN_WRITE_FAILED', `无法生成原生管理员令牌: ${error.message}`)
      }
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  try { chmodSync(path, 0o600) } catch (error) { throw new SubscriptionError('ADMIN_TOKEN_MODE_FAILED', `无法设置管理员令牌权限: ${error.message}`) }
  return token
}

export function ensureIdentityHmacKey(path = join(DEFAULT_PRIVATE_ROOT, 'identity-hmac-key')) {
  if (path === ':memory:') return randomBytes(32)
  ensurePrivateRoot(dirname(path))
  let value
  try {
    value = readFileSync(path)
    if (value.length >= 32 && value.length <= 256) {
      ensurePrivateFileMode(path, 0o600)
      return value
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new SubscriptionError('IDENTITY_KEY_READ_FAILED', `无法读取订阅身份密钥: ${error.message}`)
  }
  const generated = randomBytes(32)
  let fd
  try {
    fd = openSync(path, 'wx', 0o600)
    writeFileSync(fd, generated)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      value = readFileSync(path)
      if (value.length < 32 || value.length > 256) throw new SubscriptionError('IDENTITY_KEY_INVALID', '订阅身份密钥文件无效')
      return value
    }
    throw new SubscriptionError('IDENTITY_KEY_WRITE_FAILED', `无法生成订阅身份密钥: ${error.message}`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  ensurePrivateFileMode(path, 0o600)
  return generated
}

export function ensureShrimpTankSystemToken(path = join(DEFAULT_PRIVATE_ROOT, 'shrimptank-system-token')) {
  if (path === ':memory:') return randomBytes(32).toString('base64url')
  ensurePrivateRoot(dirname(path))
  let token = ''
  try { token = readFileSync(path, 'utf8').trim() } catch (error) {
    if (error?.code !== 'ENOENT') throw new SubscriptionError('SHRIMPTANK_TOKEN_READ_FAILED', `无法读取 ShrimpTank system token: ${error.message}`)
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
    token = randomBytes(32).toString('base64url')
    let fd
    try {
      fd = openSync(path, 'wx', 0o600)
      writeFileSync(fd, `${token}\n`, 'utf8')
    } catch (error) {
      if (error?.code === 'EEXIST') token = readFileSync(path, 'utf8').trim()
      else throw new SubscriptionError('SHRIMPTANK_TOKEN_WRITE_FAILED', `无法生成 ShrimpTank system token: ${error.message}`)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw new SubscriptionError('SHRIMPTANK_TOKEN_INVALID', 'ShrimpTank system token 文件无效')
  ensurePrivateFileMode(path, 0o600)
  return token
}

export function subscriberIdentityHmac(staffId, secret) {
  const value = String(staffId ?? '')
  if (!STAFF_RE.test(value)) throw new SubscriptionError('STAFF_ID_INVALID', '钉钉身份无效')
  if (!secret || (typeof secret !== 'string' && !Buffer.isBuffer(secret))) throw new SubscriptionError('IDENTITY_SECRET_MISSING', '订阅身份 HMAC secret 未配置')
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex')
}

export function normalizeConversationType(value) {
  const type = String(value ?? '').trim().toLowerCase()
  return type === 'direct' || type === 'private' || type === 'single' ? 'direct' : type
}

function credentialRef(value) {
  const ref = text(value, 'credentialRef', 500)
  if (/(?:secret|token|password|api[-_]?key)\s*[:=]/iu.test(ref) || ref.length > 240) throw new SubscriptionError('CREDENTIAL_VALUE_FORBIDDEN', 'robot_accounts 只允许保存 credential ref，不允许写入密钥')
  return ref
}

function actorFrom(options = {}, fallback = ROLE_SYSTEM_OWNER) {
  const role = String(options.actorRole || options.actor?.role || fallback)
  if (![ROLE_SYSTEM_OWNER, ROLE_SUBSCRIBER].includes(role)) throw new SubscriptionError('ACTOR_ROLE_INVALID', '调用者角色无效')
  return { role, id: options.actorId || options.actor?.id || null }
}

/**
 * Host-side durable control plane.  It intentionally exposes no JSON file
 * backend: node:sqlite + WAL is a hard requirement for subscriber state.
 */
export class DingTalkSubscriptionService {
  constructor(options = {}) {
    this.clock = options.now || (() => new Date())
    this.timezone = SHANGHAI_TIME_ZONE
    this.privateRoot = options.privateRoot || DEFAULT_PRIVATE_ROOT
    this.dbPath = defaultDbPath(options.dbPath || (options.privateRoot ? join(this.privateRoot, 'subscriptions.sqlite') : undefined))
    this.store = options.store || new SubscriptionStore({ dbPath: this.dbPath, privateRoot: this.privateRoot })
    this.ownsStore = !options.store
    const suppliedSecret = options.hmacSecret ?? options.identitySecret ?? options.subscriberHmacSecret ?? process.env.DSH_DINGTALK_IDENTITY_SECRET
    this.identityHmacKeyPath = options.identityHmacKeyPath || join(this.privateRoot, 'identity-hmac-key')
    this.hmacSecret = suppliedSecret && (typeof suppliedSecret === 'string' || Buffer.isBuffer(suppliedSecret)) ? suppliedSecret : ensureIdentityHmacKey(this.identityHmacKeyPath)
    this.ephemeralIdentitySecret = false
    this.dshRoot = options.dshRoot || process.env.DSH_HOME || join(homedir(), '.dsh')
    this.shrimpRoot = options.shrimpRoot || join(homedir(), 'Desktop', '虾缸')
    this.appRoot = options.appRoot || '/Applications/大神.app'
    this.nativeAdminTokenPath = options.nativeAdminTokenPath || defaultNativeAdminTokenPath(this.privateRoot)
    this.nativeAdminToken = options.nativeAdminToken || ensureNativeAdminToken(this.nativeAdminTokenPath)
    this.shrimpTankSystemTokenPath = options.shrimpTankSystemTokenPath || join(this.privateRoot, 'shrimptank-system-token')
    if (!options.shrimpTankSystemToken) ensureShrimpTankSystemToken(this.shrimpTankSystemTokenPath)
    this.shrimpTankSystemToken = options.shrimpTankSystemToken || null
    this.defaultWorkspaceRoot = options.defaultWorkspaceRoot || join(homedir(), 'Documents', DEFAULT_WORKSPACE_FOLDER)
    this.agentPresets = options.agentPresets || null
    this.agentPresetsResolver = options.agentPresetsResolver || null
    this.workspaceRegistry = options.workspaceRegistry || null
    this.workspaceRegistryResolver = options.workspaceRegistryResolver || null
    this.llm = options.llm || null
    this.llmResolver = options.llmResolver || null
    this.shrimpCatalog = options.shrimpCatalog || null
    this.shrimpCatalogResolver = options.shrimpCatalogResolver || null
    this.meteredProviders = new Set(Array.isArray(options.meteredProviders) ? options.meteredProviders.map(String) : DEFAULT_METERED_PROVIDERS)
    this.shrimpCatalogCache = []
    this.credentialWriter = options.credentialWriter || null
    this.credentialResolver = options.credentialResolver || null
    this.registrationManager = options.registrationManager || null
    this.registrationResolver = options.registrationResolver || null
    this.registrationJobs = new Map()
    this.protectedFingerprintSources = new Map()
    this.brand = Object.freeze({ ...BRAND, avatarSha256: options.avatarSha256 || BRAND_AVATAR_SHA256 })
    this.robotAccountListeners = new Set()
    this._ensureDefaultCalendars()
  }

  close() {
    for (const job of this.registrationJobs.values()) job.cancelled = true
    this.registrationJobs.clear()
    this.protectedFingerprintSources.clear()
    this.robotAccountListeners.clear()
    if (this.ownsStore) this.store.close()
  }

  onRobotAccountsChanged(listener) {
    if (typeof listener !== 'function') throw new SubscriptionError('LISTENER_INVALID', '机器人账户监听器必须是函数')
    this.robotAccountListeners.add(listener)
    return () => this.robotAccountListeners.delete(listener)
  }

  _emitRobotAccountsChanged(reason, details = {}) {
    const snapshot = this.listActiveRobotSpecs()
    for (const listener of this.robotAccountListeners) {
      try { listener(snapshot, { reason, ...details }) } catch { /* a listener must not break Host state */ }
    }
  }

  listActiveRobotSpecs() {
    return this.store.all(`SELECT r.*, s.status AS subscriber_status FROM robot_accounts r JOIN subscribers s ON s.subscriber_id = r.subscriber_id WHERE r.status IN ('active','pending') AND s.status NOT IN ('revoked','suspended') ORDER BY r.created_at ASC`).map((row) => ({
      accountId: row.account_id,
      subscriberId: row.subscriber_id,
      credentialRef: row.credential_ref,
      robotCode: row.robot_code || null,
      status: row.status,
      brandStatus: row.brand_status,
      subscriberStatus: row.subscriber_status,
    }))
  }

  _time() { return nowIso(this.clock) }

  _identity(staffId) { return subscriberIdentityHmac(staffId, this.hmacSecret) }

  _audit(action, { actorRole = ROLE_SYSTEM_OWNER, actorId = null, subscriberId = null, outcome = 'success', details = {} } = {}) {
    const at = this._time()
    const cleanDetails = sanitizeMetadata(details)
    this.store.run(`INSERT INTO audit_events(event_id,action,actor_role,actor_id_hmac,subscriber_id,outcome,details_json,created_at) VALUES (?,?,?,?,?,?,?,?)`, randomUUID(), text(action, '审计动作', 120), actorRole, actorId ? this._identity(actorId) : null, subscriberId || null, outcome, jsonText(cleanDetails), at)
  }

  _ensureDefaultCalendars() {
    const at = this._time()
    this.store.transaction(() => {
      for (const calendar of Object.values(DEFAULT_HOLIDAY_CALENDARS)) {
        const normalized = normalizeHolidayCalendar(calendar)
        this.store.run(`INSERT OR IGNORE INTO holiday_calendars(year,timezone,source_url,source_title,source_checksum,workdays_json,restdays_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`, normalized.year, normalized.timezone, normalized.sourceUrl, normalized.sourceTitle, calendarChecksum(normalized), jsonText(normalized.workingDays), jsonText(normalized.restDays), at, at)
      }
    })
  }

  _subscriberRow(subscriberId) {
    return this.store.get('SELECT * FROM subscribers WHERE subscriber_id = ?', id(subscriberId, '订阅者 ID'))
  }

  _requireSubscriber(subscriberId) {
    const row = this._subscriberRow(subscriberId)
    if (!row) throw new SubscriptionError('SUBSCRIBER_NOT_FOUND', '订阅者不存在', { subscriberId })
    return row
  }

  _requireSystemActor(options = {}) {
    const actor = actorFrom(options)
    if (actor.role !== ROLE_SYSTEM_OWNER) throw new SubscriptionError('ADMIN_ONLY', '只有系统管理员可以执行该操作', undefined, 403)
    return actor
  }

  _checkExpectedRevision(row, expectedRevision, label = '记录') {
    if (expectedRevision === undefined || expectedRevision === null) return
    const expected = number(expectedRevision, `${label} revision`, { min: 1 })
    if (Number(row?.revision || 0) !== expected) throw new SubscriptionError('CAS_CONFLICT', `${label}已变化，请重新读取后提交`, { expectedRevision: expected, actualRevision: Number(row?.revision || 0) }, 409)
  }

  _workspaceDecision(rootPath) {
    const path = resolve(text(rootPath, '工作区路径', 2_000))
    const protectedDecision = workspacePathDecision(path, path, { dshRoot: this.dshRoot, shrimpRoot: this.shrimpRoot, appRoot: this.appRoot, credentialsRoot: join(this.dshRoot, 'private') })
    if (protectedDecision.code === 'SUBSCRIBER_CORE_PATH_BLOCKED') throw new SubscriptionError('WORKSPACE_PROTECTED', '订阅工作区不能位于大神本体、凭据或虾缸目录')
    const protectedRoots = [resolve(this.dshRoot), resolve(this.shrimpRoot), resolve(this.appRoot)]
    if (protectedRoots.some((root) => path === root || root.startsWith(`${path}${sep}`))) throw new SubscriptionError('WORKSPACE_PROTECTED', '订阅工作区不能使用或包住受保护根目录')
    return path
  }

  _recomputeStatus(subscriberId, tx = this.store) {
    const row = tx.get('SELECT * FROM subscribers WHERE subscriber_id = ?', subscriberId)
    if (!row || row.status === SUBSCRIBER_STATUSES.SUSPENDED || row.status === SUBSCRIBER_STATUSES.REVOKED) return row?.status || null
    const account = tx.get('SELECT * FROM robot_accounts WHERE subscriber_id = ?', subscriberId)
    let next = SUBSCRIBER_STATUSES.PENDING
    if (!account) next = SUBSCRIBER_STATUSES.PENDING
    else if (account.brand_status !== 'verified' || account.status !== 'active') next = SUBSCRIBER_STATUSES.WAITING_ROBOT
    else if (!row.identity_hmac) next = SUBSCRIBER_STATUSES.WAITING_BINDING
    else {
      const workspace = tx.get(`SELECT w.* FROM workspaces w JOIN entitlements e ON e.resource_id = w.workspace_id AND e.kind = 'workspace' AND e.status = 'active' WHERE e.subscriber_id = ? AND w.status = 'active' LIMIT 1`, subscriberId)
      const selection = tx.get('SELECT * FROM selections WHERE subscriber_id = ?', subscriberId)
      if (!workspace || !selection?.workspace_id) next = SUBSCRIBER_STATUSES.WAITING_WORKSPACE
      else if (!selection.mode_id || !selection.model_id || !selection.effort_id || Number(row.weekly_token_limit || 0) <= 0) next = SUBSCRIBER_STATUSES.WAITING_CONFIGURATION
      else next = SUBSCRIBER_STATUSES.ACTIVE
    }
    if (row.status !== next) tx.run('UPDATE subscribers SET status = ?, revision = revision + 1, updated_at = ? WHERE subscriber_id = ?', next, this._time(), subscriberId)
    return next
  }

  _queueSubscriberSync(subscriberId, reason, tx = this.store) {
    const row = tx.get('SELECT revision FROM subscribers WHERE subscriber_id = ?', subscriberId)
    if (!row) return null
    const at = this._time()
    const key = `subscriber-sync:${subscriberId}:${Number(row.revision || 1)}:${String(reason || 'change').slice(0, 80)}`
    tx.run('INSERT OR IGNORE INTO outbox(outbox_id,kind,aggregate_id,idempotency_key,payload_json,status,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', `out_${randomUUID()}`, 'shrimptank.subscriber.sync', subscriberId, key, jsonText({ subscriberId, reason, revision: Number(row.revision || 1) }), 'pending', 0, at, at)
    return key
  }

  getSubscriber(subscriberId) {
    if (subscriberId && typeof subscriberId === 'object') subscriberId = subscriberId.subscriberId
    return mapSubscriber(this._subscriberRow(subscriberId))
  }

  listSubscribers() {
    return this.store.all('SELECT * FROM subscribers ORDER BY created_at ASC').map(mapSubscriber)
  }

  createSubscriber(input = {}, options = {}) {
    this._requireSystemActor(options)
    const displayName = text(input.displayName ?? input.name, '订阅者名称', 200)
    const subscriberId = input.subscriberId ? id(input.subscriberId, '订阅者 ID') : `sub_${randomUUID()}`
    const weeklyTokenLimit = number(input.weeklyTokenLimit ?? input.tokenLimit ?? 0, '每周 Token 额度', { min: 0, max: Number.MAX_SAFE_INTEGER })
    const metadata = sanitizeMetadata(input.metadata)
    const at = this._time()
    try {
      this.store.transaction(() => {
        this.store.run('INSERT INTO subscribers(subscriber_id,display_name,status,weekly_token_limit,revision,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', subscriberId, displayName, SUBSCRIBER_STATUSES.PENDING, weeklyTokenLimit, 1, jsonText(metadata), at, at)
        this._audit('subscriber.create', { subscriberId, details: { displayName, weeklyTokenLimit } })
      })
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) throw new SubscriptionError('SUBSCRIBER_EXISTS', '订阅者 ID 已存在')
      throw error
    }
    return this.getSubscriber(subscriberId)
  }

  updateSubscriber(subscriberId, patch = {}, options = {}) {
    this._requireSystemActor(options)
    const current = this._requireSubscriber(subscriberId)
    this._checkExpectedRevision(current, options.expectedRevision ?? patch.expectedRevision, '订阅者')
    const fields = []
    const values = []
    const weeklyTokenLimit = patch.weeklyTokenLimit !== undefined || patch.tokenLimit !== undefined
      ? number(patch.weeklyTokenLimit ?? patch.tokenLimit, '每周 Token 额度', { min: 0, max: Number.MAX_SAFE_INTEGER })
      : null
    if (patch.displayName !== undefined || patch.name !== undefined) { fields.push('display_name = ?'); values.push(text(patch.displayName ?? patch.name, '订阅者名称', 200)) }
    if (weeklyTokenLimit !== null) { fields.push('weekly_token_limit = ?'); values.push(weeklyTokenLimit) }
    if (patch.metadata !== undefined) fields.push('metadata_json = ?'), values.push(jsonText(sanitizeMetadata(patch.metadata)))
    if (!fields.length) return this.getSubscriber(subscriberId)
    fields.push('revision = revision + 1', 'updated_at = ?'); values.push(this._time(), subscriberId)
    this.store.transaction(() => {
      const result = this.store.run(`UPDATE subscribers SET ${fields.join(', ')} WHERE subscriber_id = ? AND revision = ?`, ...values.slice(0, -1), subscriberId, Number(current.revision))
      if (!result.changes) throw new SubscriptionError('CAS_CONFLICT', '订阅者已变化，请重新读取后提交', undefined, 409)
      // Changing the configured weekly allowance changes the current cycle's
      // ceiling without erasing usage.  Only resetQuota may clear usage.
      if (weeklyTokenLimit !== null) {
        const cycle = this._cycleFor(subscriberId, this._time(), true)
        this.store.run('UPDATE quota_cycles SET limit_tokens = ?, updated_at = ? WHERE cycle_id = ?', weeklyTokenLimit, this._time(), cycle.cycle_id)
      }
      this._recomputeStatus(subscriberId)
      this._queueSubscriberSync(subscriberId, 'subscriber.update')
      this._audit('subscriber.update', { subscriberId, details: { fields: fields.filter((field) => !field.startsWith('metadata')), weeklyTokenLimit } })
    })
    return this.getSubscriber(subscriberId)
  }

  _setSubscriberStatus(subscriberId, status, action, options = {}) {
    this._requireSystemActor(options)
    const current = this._requireSubscriber(subscriberId)
    this._checkExpectedRevision(current, options.expectedRevision, '订阅者')
    if (![SUBSCRIBER_STATUSES.SUSPENDED, SUBSCRIBER_STATUSES.REVOKED].includes(status)) throw new SubscriptionError('STATUS_INVALID', '不支持的订阅状态')
    this.store.transaction(() => {
      const result = this.store.run('UPDATE subscribers SET status = ?, revision = revision + 1, updated_at = ? WHERE subscriber_id = ? AND revision = ?', status, this._time(), subscriberId, Number(current.revision))
      if (!result.changes) throw new SubscriptionError('CAS_CONFLICT', '订阅者已变化，请重新读取后提交', undefined, 409)
      this._queueSubscriberSync(subscriberId, action)
      this._audit(action, { subscriberId, details: { status } })
    })
    this._emitRobotAccountsChanged(action, { subscriberId })
    return this.getSubscriber(subscriberId)
  }

  suspendSubscriber(subscriberId, options = {}) { return this._setSubscriberStatus(subscriberId, SUBSCRIBER_STATUSES.SUSPENDED, 'subscriber.suspend', options) }

  resumeSubscriber(subscriberId, options = {}) {
    this._requireSystemActor(options)
    const current = this._requireSubscriber(subscriberId)
    this._checkExpectedRevision(current, options.expectedRevision, '订阅者')
    if (current.status !== SUBSCRIBER_STATUSES.SUSPENDED) return this.getSubscriber(subscriberId)
    this.store.transaction(() => {
      this.store.run('UPDATE subscribers SET status = ?, revision = revision + 1, updated_at = ? WHERE subscriber_id = ? AND revision = ?', SUBSCRIBER_STATUSES.PENDING, this._time(), subscriberId, Number(current.revision))
      this._recomputeStatus(subscriberId)
      this._queueSubscriberSync(subscriberId, 'subscriber.resume')
      this._audit('subscriber.resume', { subscriberId })
    })
    this._emitRobotAccountsChanged('subscriber.resume', { subscriberId })
    return this.getSubscriber(subscriberId)
  }

  revokeSubscriber(subscriberId, options = {}) {
    const value = this._setSubscriberStatus(subscriberId, SUBSCRIBER_STATUSES.REVOKED, 'subscriber.revoke', options)
    this.store.run('UPDATE robot_accounts SET status = ?, updated_at = ?, revision = revision + 1 WHERE subscriber_id = ?', 'revoked', this._time(), subscriberId)
    this._emitRobotAccountsChanged('subscriber.revoke', { subscriberId })
    return value
  }

  registerRobotAccount(input = {}, options = {}) {
    this._requireSystemActor(options)
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    this._requireSubscriber(subscriberId)
    const accountId = input.accountId ? id(input.accountId, '机器人账户 ID') : `acct_${randomUUID()}`
    const ref = credentialRef(input.credentialRef ?? input.credentialsRef)
    const robotCode = optionalText(input.robotCode, 300)
    const at = this._time()
    try {
      this.store.transaction(() => {
        this.store.run('INSERT INTO robot_accounts(account_id,subscriber_id,credential_ref,robot_code,robot_name,robot_description,brand_status,status,revision,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', accountId, subscriberId, ref, robotCode, BRAND_NAME, BRAND_DESCRIPTION, 'pending', 'pending', 1, jsonText(sanitizeMetadata(input.metadata)), at, at)
        this._recomputeStatus(subscriberId)
        this._queueSubscriberSync(subscriberId, 'robot.register')
        this._audit('robot.register', { subscriberId, details: { accountId, credentialRef: ref } })
      })
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) throw new SubscriptionError('ROBOT_ACCOUNT_EXISTS', '订阅者已有机器人账户')
      throw error
    }
    const row = this.store.get('SELECT * FROM robot_accounts WHERE account_id = ?', accountId)
    this._emitRobotAccountsChanged('robot.register', { subscriberId, accountId })
    return mapRobot(row)
  }

  createRobotAccount(input = {}, options = {}) { return this.registerRobotAccount(input, options) }

  getRobotAccount(accountId) {
    if (accountId && typeof accountId === 'object') accountId = accountId.accountId
    return mapRobot(this.store.get('SELECT * FROM robot_accounts WHERE account_id = ?', id(accountId, '机器人账户 ID')))
  }

  listRobotAccounts(subscriberId = undefined) {
    if (subscriberId && typeof subscriberId === 'object') subscriberId = subscriberId.subscriberId
    if (subscriberId) return this.store.all('SELECT * FROM robot_accounts WHERE subscriber_id = ? ORDER BY created_at ASC', id(subscriberId, '订阅者 ID')).map(mapRobot)
    return this.store.all('SELECT * FROM robot_accounts ORDER BY created_at ASC').map(mapRobot)
  }

  updateRobotBrand(accountId, input = {}, options = {}) {
    if (accountId && typeof accountId === 'object') {
      const value = accountId
      accountId = value.accountId
      input = value
      options = input.options || options
    }
    this._requireSystemActor(options)
    const account = this.store.get('SELECT * FROM robot_accounts WHERE account_id = ?', id(accountId, '机器人账户 ID'))
    if (!account) throw new SubscriptionError('ROBOT_ACCOUNT_NOT_FOUND', '机器人账户不存在')
    this._checkExpectedRevision(account, options.expectedRevision ?? input.expectedRevision, '机器人账户')
    // Brand verification is byte-for-byte at the semantic string level.  Do
    // not NFKC-normalize the full-width vertical bar in the locked copy.
    const robotName = literalText(input.robotName ?? input.name, '机器人名称', 200)
    const robotDescription = literalText(input.robotDescription ?? input.description, '机器人描述', 500)
    const avatarSha256 = optionalText(input.avatarSha256 ?? input.avatarHash, 128)
    const verified = robotName === BRAND_NAME && robotDescription === BRAND_DESCRIPTION && Boolean(this.brand.avatarSha256 ? avatarSha256 === this.brand.avatarSha256 : avatarSha256)
    this.store.transaction(() => {
      const result = this.store.run('UPDATE robot_accounts SET robot_name = ?, robot_description = ?, avatar_sha256 = ?, brand_status = ?, status = ?, revision = revision + 1, updated_at = ? WHERE account_id = ? AND revision = ?', robotName, robotDescription, avatarSha256, verified ? 'verified' : 'mismatch', verified ? 'active' : 'pending', this._time(), account.account_id, Number(account.revision))
      if (!result.changes) throw new SubscriptionError('CAS_CONFLICT', '机器人账户已变化，请重新读取后提交', undefined, 409)
      this._recomputeStatus(account.subscriber_id)
      this._audit('robot.brand.verify', { subscriberId: account.subscriber_id, details: { accountId: account.account_id, verified, brandName: robotName, brandDescription: robotDescription, verificationMethod: input.attested === true ? 'administrator_attestation' : 'api_readback' } })
    })
    this._emitRobotAccountsChanged('robot.brand.verify', { subscriberId: account.subscriber_id, accountId: account.account_id })
    return this.getRobotAccount(accountId)
  }

  verifyRobotBrand(accountId, input = {}, options = {}) { return this.updateRobotBrand(accountId, input, options) }

  _credentialPrefix(accountId, supplied = undefined) {
    if (supplied) return credentialRef(supplied)
    return `DINGTALK_SUBSCRIBER_${String(accountId).replace(/[^A-Za-z0-9_]/gu, '_').toUpperCase()}`
  }

  async _credentialSet(name, value) {
    if (typeof this.credentialWriter?.set !== 'function') throw new SubscriptionError('CREDENTIAL_WRITER_MISSING', 'Host credentials 服务不可用')
    return this.credentialWriter.set(name, value)
  }

  async _credentialDelete(name) {
    try {
      if (typeof this.credentialWriter?.unset === 'function') return await this.credentialWriter.unset(name)
      if (typeof this.credentialWriter?.delete === 'function') return await this.credentialWriter.delete(name)
      if (typeof this.credentialWriter?.remove === 'function') return await this.credentialWriter.remove(name)
    } catch { /* cleanup is best effort; never expose the original secret */ }
    return undefined
  }

  /** Persist only credential names in SQLite; values remain in Host keychain. */
  async persistRobotCredentials(input = {}, options = {}) {
    this._requireSystemActor(options)
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    this._requireSubscriber(subscriberId)
    const accountId = input.accountId ? id(input.accountId, '机器人账户 ID') : `acct_${randomUUID()}`
    const clientId = literalText(input.clientId, 'DingTalk clientId', 500)
    const clientSecret = literalText(input.clientSecret, 'DingTalk clientSecret', 1_000)
    const prefix = this._credentialPrefix(accountId, input.credentialPrefix)
    const names = { clientId: `${prefix}_CLIENT_ID`, clientSecret: `${prefix}_CLIENT_SECRET` }
    let idWritten = false
    let cleanupAllowed = true
    try {
      await this._credentialSet(names.clientId, clientId)
      idWritten = true
      await this._credentialSet(names.clientSecret, clientSecret)
      const current = this.store.get('SELECT * FROM robot_accounts WHERE account_id = ?', accountId)
      if (current) {
        cleanupAllowed = current.credential_ref !== prefix
        this._checkExpectedRevision(current, options.expectedRevision ?? input.expectedRevision, '机器人账户')
        const changed = this.store.run('UPDATE robot_accounts SET credential_ref = ?, revision = revision + 1, updated_at = ? WHERE account_id = ? AND revision = ?', prefix, this._time(), accountId, Number(current.revision))
        if (!changed.changes) throw new SubscriptionError('CAS_CONFLICT', '机器人账户已变化，请重新读取后提交', undefined, 409)
      } else {
        this.registerRobotAccount({ subscriberId, accountId, credentialRef: prefix, robotCode: input.robotCode, metadata: input.metadata }, options)
      }
      this._emitRobotAccountsChanged('robot.credentials.persist', { subscriberId, accountId })
      return { ok: true, subscriberId, accountId, credentialRef: prefix, credentialNames: names, robotAccount: this.getRobotAccount(accountId) }
    } catch (error) {
      if (cleanupAllowed && idWritten) await this._credentialDelete(names.clientId)
      if (cleanupAllowed) await this._credentialDelete(names.clientSecret)
      throw error
    }
  }

  async resolveRobotCredentials(input = {}) {
    const accountId = id(input.accountId, '机器人账户 ID')
    const account = this.store.get('SELECT * FROM robot_accounts WHERE account_id = ?', accountId)
    if (!account) throw new SubscriptionError('ROBOT_ACCOUNT_NOT_FOUND', '机器人账户不存在')
    const resolver = this.credentialResolver || this.credentialWriter
    if (typeof resolver?.resolve !== 'function') throw new SubscriptionError('CREDENTIAL_READER_MISSING', 'Host credentials 服务不可用')
    const prefix = account.credential_ref
    const read = async (name) => {
      const value = await resolver.resolve(name)
      return value && typeof value === 'object' ? value.value : value
    }
    const clientId = await read(`${prefix}_CLIENT_ID`)
    const clientSecret = await read(`${prefix}_CLIENT_SECRET`)
    if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret) throw new SubscriptionError('CREDENTIALS_MISSING', '机器人凭据尚未准备完成')
    return { accountId, subscriberId: account.subscriber_id, clientId, clientSecret, credentialRef: prefix }
  }

  _registrationManager() {
    return this.registrationManager || (typeof this.registrationResolver === 'function' ? this.registrationResolver() : null)
  }

  _safeRegistration(value) {
    const source = value && typeof value === 'object' ? value : {}
    const allowed = ['status', 'registrationId', 'registration_id', 'verificationUri', 'verification_uri', 'verificationUriComplete', 'verification_uri_complete', 'qrSvg', 'qr_svg', 'qrDataUrl', 'qr_data_url', 'expiresAt', 'expires_at', 'challengeId', 'challenge_id', 'accountId', 'account_id', 'subscriberId', 'subscriber_id', 'message', 'error', 'ready', 'pending']
    const output = {}
    for (const key of allowed) {
      if (source[key] === undefined || source[key] === null) continue
      const target = key === 'verificationUriComplete' || key === 'verification_uri_complete' || key === 'verification_uri'
        ? 'verificationUri'
        : key.replace(/_([a-z])/gu, (_, character) => character.toUpperCase())
      const val = source[key]
      output[target] = typeof val === 'string' ? val.slice(0, key.toLowerCase().includes('svg') || key.toLowerCase().includes('dataurl') ? 256_000 : 2_000) : typeof val === 'boolean' || typeof val === 'number' ? val : String(val).slice(0, 2_000)
    }
    delete output.deviceCode
    delete output.clientId
    delete output.clientSecret
    delete output.token
    delete output.accessToken
    delete output.secret
    delete output.credentials
    return output
  }

  async _registrationWithQr(value) {
    const safe = this._safeRegistration(value)
    if (!safe.verificationUri || safe.qrSvg || safe.qrDataUrl) return safe
    try {
      const qrcode = await import('qrcode')
      const api = qrcode.default || qrcode
      if (typeof api.toString === 'function') safe.qrSvg = String(await api.toString(safe.verificationUri, { type: 'svg', margin: 1, width: 512 })).slice(0, 256_000)
      else if (typeof api.toDataURL === 'function') safe.qrDataUrl = String(await api.toDataURL(safe.verificationUri, { margin: 1, width: 512 })).slice(0, 256_000)
    } catch { /* the native panel can display verificationUri for manual flow */ }
    return safe
  }

  async beginRegistration(input = {}, options = {}) {
    this._requireSystemActor(options)
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    this._requireSubscriber(subscriberId)
    const manager = this._registrationManager()
    if (typeof manager?.beginRegistration !== 'function') throw new SubscriptionError('REGISTRATION_MANAGER_MISSING', '钉钉机器人注册服务不可用')
    const result = await manager.beginRegistration({ subscriberId, accountId: input.accountId || null, brand: BRAND })
    const safe = await this._registrationWithQr({ ...result, subscriberId, accountId: input.accountId || result?.accountId || result?.account_id })
    const registrationId = safe.registrationId || safe.challengeId
    if (!registrationId) throw new SubscriptionError('REGISTRATION_ID_MISSING', '钉钉注册服务未返回 registrationId')
    const job = { registrationId, subscriberId, accountId: safe.accountId || input.accountId || null, status: 'pending', result: { ...safe, registrationId }, cancelled: false }
    this.registrationJobs.set(registrationId, job)
    this.store.transaction(() => {
      this.store.run('INSERT OR IGNORE INTO outbox(outbox_id,kind,aggregate_id,idempotency_key,payload_json,status,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', `out_${randomUUID()}`, 'dingtalk.registration.begin', subscriberId, `registration:${registrationId}`, jsonText({ subscriberId, accountId: safe.accountId || input.accountId || null, registrationId, status: 'pending', expiresAt: safe.expiresAt || null }), 'pending', 0, this._time(), this._time())
      this._audit('registration.begin', { subscriberId, details: { accountId: safe.accountId || input.accountId || null, registrationId, status: 'pending', expiresAt: safe.expiresAt || null, verificationUriSha256: safe.verificationUri ? createHash('sha256').update(safe.verificationUri, 'utf8').digest('hex') : null } })
    })
    void this._runRegistrationJob(job, manager)
    return { ok: true, ...safe, registrationId, status: 'pending' }
  }

  async _runRegistrationJob(job, manager) {
    try {
      if (job.cancelled) return
      const result = typeof manager.waitForCredentials === 'function'
        ? manager.waitForCredentials.length >= 2
          ? await manager.waitForCredentials(job.registrationId, { subscriberId: job.subscriberId, accountId: job.accountId })
          : await manager.waitForCredentials({ registrationId: job.registrationId, subscriberId: job.subscriberId, accountId: job.accountId })
        : null
      if (job.cancelled) return
      const safe = this._safeRegistration({ ...result, registrationId: job.registrationId, subscriberId: job.subscriberId, accountId: job.accountId || result?.accountId || result?.account_id })
      if (result?.persisted === false) throw new SubscriptionError('REGISTRATION_CREDENTIALS_NOT_PERSISTED', '扫码已完成，但机器人凭据未被大神安全接管，请重新生成二维码')
      const persisted = result?.pending !== true && result?.status !== 'pending'
      const account = job.accountId ? this.getRobotAccount(job.accountId) : mapRobot(this.store.get('SELECT * FROM robot_accounts WHERE subscriber_id = ?', job.subscriberId))
      if (!job.accountId && account?.accountId) job.accountId = account.accountId
      job.status = !persisted ? 'pending' : account?.brandStatus === 'verified' ? 'succeeded' : 'brand-pending'
      job.result = { ...safe, registrationId: job.registrationId, status: job.status }
      this._markRegistrationOutbox(job, job.status === 'succeeded' || job.status === 'brand-pending' ? 'completed' : 'pending')
    } catch (error) {
      if (job.cancelled) return
      job.status = 'failed'
      job.result = { registrationId: job.registrationId, subscriberId: job.subscriberId, accountId: job.accountId, status: 'failed', error: String(error?.message || error).slice(0, 300) }
      this._markRegistrationOutbox(job, 'failed', error?.code || 'REGISTRATION_FAILED')
    }
  }

  _markRegistrationOutbox(job, status, error = null) {
    const row = this.store.get('SELECT outbox_id FROM outbox WHERE idempotency_key = ?', `registration:${job.registrationId}`)
    if (row) this.store.run('UPDATE outbox SET status = ?, last_error = ?, updated_at = ? WHERE outbox_id = ?', status, error, this._time(), row.outbox_id)
  }

  async registrationStatus(input = {}, options = {}) {
    this._requireSystemActor(options)
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    const registrationId = text(input.registrationId, 'registrationId', 300)
    const job = this.registrationJobs.get(registrationId)
    if (!job || job.subscriberId !== subscriberId) throw new SubscriptionError('REGISTRATION_NOT_FOUND', '注册任务不存在')
    if (job.status === 'brand-pending') {
      const account = job.accountId ? this.getRobotAccount(job.accountId) : mapRobot(this.store.get('SELECT * FROM robot_accounts WHERE subscriber_id = ?', subscriberId))
      if (account?.brandStatus === 'verified') {
        if (!job.accountId) job.accountId = account.accountId
        job.status = 'succeeded'
        job.result = { ...job.result, status: 'succeeded', accountId: account.accountId }
        this._markRegistrationOutbox(job, 'completed')
      }
    }
    return { ok: true, ...this._safeRegistration({ ...job.result, registrationId, subscriberId, accountId: job.accountId, status: job.status }) }
  }

  async waitForRegistrationCredentials(input = {}, options = {}) {
    this._requireSystemActor(options)
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    const registrationId = text(input.registrationId, 'registrationId', 300)
    const job = this.registrationJobs.get(registrationId)
    if (!job || job.subscriberId !== subscriberId) throw new SubscriptionError('REGISTRATION_NOT_FOUND', '注册任务不存在')
    return { ok: true, pending: job.status === 'pending', ...this._safeRegistration({ ...job.result, registrationId, subscriberId, accountId: job.accountId, status: job.status }) }
  }

  async cancelRegistration(input = {}, options = {}) {
    this._requireSystemActor(options)
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    const registrationId = input.registrationId ? text(input.registrationId, 'registrationId', 300) : null
    const job = registrationId ? this.registrationJobs.get(registrationId) : null
    const manager = this._registrationManager()
    if (typeof manager?.cancelRegistration !== 'function' && typeof manager?.cancel !== 'function') throw new SubscriptionError('REGISTRATION_MANAGER_MISSING', '钉钉机器人注册服务不可用')
    if (job && job.subscriberId === subscriberId) { job.cancelled = true; job.status = 'cancelled'; job.result = { ...job.result, status: 'cancelled', registrationId }; this._markRegistrationOutbox(job, 'failed', 'REGISTRATION_CANCELLED') }
    const result = typeof manager.cancelRegistration === 'function' ? await manager.cancelRegistration({ subscriberId, accountId: input.accountId || job?.accountId || null, registrationId }) : await manager.cancel({ subscriberId, accountId: input.accountId || job?.accountId || null, registrationId })
    return { ok: true, ...this._safeRegistration({ ...result, subscriberId, accountId: input.accountId || job?.accountId, registrationId }) }
  }

  createWorkspace(input = {}, options = {}) {
    this._requireSystemActor(options)
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    this._requireSubscriber(subscriberId)
    const workspaceId = input.workspaceId ? id(input.workspaceId, '工作区 ID') : `ws_${randomUUID()}`
    const displayName = text(input.displayName ?? input.name ?? '订阅工作区', '工作区名称', 300)
    const rootPath = this._workspaceDecision(input.rootPath ?? input.path ?? join(this.defaultWorkspaceRoot, subscriberId))
    const metadata = sanitizeMetadata(input.metadata)
    const at = this._time()
    const existing = this.store.get('SELECT * FROM workspaces WHERE subscriber_id = ? AND root_path = ? AND status = ?', subscriberId, rootPath, 'active')
    if (existing) {
      this.grantWorkspace(subscriberId, existing.workspace_id, options)
      this._audit('workspace.reuse', { subscriberId, details: { workspaceId: existing.workspace_id, displayName: existing.display_name } })
      return { ...mapWorkspace(this.store.get('SELECT * FROM workspaces WHERE workspace_id = ?', existing.workspace_id)), reused: true }
    }
    if (input.createDirectory !== false) {
      try { mkdirSync(rootPath, { recursive: true, mode: 0o700 }) } catch (error) { throw new SubscriptionError('WORKSPACE_CREATE_FAILED', `无法创建订阅工作区: ${error.message}`) }
    }
    try {
      this.store.transaction(() => {
        this.store.run('INSERT INTO workspaces(workspace_id,subscriber_id,display_name,root_path,status,metadata_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', workspaceId, subscriberId, displayName, rootPath, 'active', jsonText(metadata), 1, at, at)
        this.store.run('INSERT OR IGNORE INTO entitlements(entitlement_id,subscriber_id,kind,resource_id,display_name,status,metadata_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', `ent_${randomUUID()}`, subscriberId, 'workspace', workspaceId, displayName, 'active', '{}', 1, at, at)
        this._autoSelectIfReady(subscriberId)
        this._recomputeStatus(subscriberId)
        this._queueSubscriberSync(subscriberId, 'workspace.create')
        this._audit('workspace.create', { subscriberId, details: { workspaceId, displayName } })
      })
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) throw new SubscriptionError('WORKSPACE_EXISTS', '工作区已存在')
      throw error
    }
    return mapWorkspace(this.store.get('SELECT * FROM workspaces WHERE workspace_id = ?', workspaceId))
  }

  getWorkspace(workspaceId) { return mapWorkspace(this.store.get('SELECT * FROM workspaces WHERE workspace_id = ?', id(workspaceId, '工作区 ID'))) }

  listWorkspaces(subscriberId = undefined) {
    if (subscriberId && typeof subscriberId === 'object') subscriberId = subscriberId.subscriberId
    if (subscriberId) return this.store.all('SELECT * FROM workspaces WHERE subscriber_id = ? ORDER BY created_at ASC', id(subscriberId, '订阅者 ID')).map(mapWorkspace)
    return this.store.all('SELECT * FROM workspaces ORDER BY created_at ASC').map(mapWorkspace)
  }

  shareHostWorkspace(input = {}, options = {}) {
    this._requireSystemActor(options)
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    this._requireSubscriber(subscriberId)
    const hostWorkspaceId = text(input.hostWorkspaceId ?? input.workspaceId, '大神工作区 ID', 500)
    let registry = this.workspaceRegistry
    try { registry = registry || this.workspaceRegistryResolver?.() } catch { registry = null }
    let source
    try { source = typeof registry?.get === 'function' ? registry.get(hostWorkspaceId) : null } catch { source = null }
    if (!source && typeof registry?.list === 'function') {
      try { source = registry.list().find((item) => String(item?.id ?? item?.workspaceId ?? '') === hostWorkspaceId) } catch { source = null }
    }
    if (!source) throw new SubscriptionError('HOST_WORKSPACE_NOT_FOUND', '大神工作区不存在或尚未同步')
    const rootPath = this._workspaceDecision(source.path ?? source.rootPath)
    const displayName = text(source.title ?? source.displayName ?? source.name ?? hostWorkspaceId, '工作区名称', 300)
    const existing = this.store.get('SELECT * FROM workspaces WHERE subscriber_id = ? AND root_path = ? AND status = ?', subscriberId, rootPath, 'active')
    if (existing) {
      this.grantWorkspace(subscriberId, existing.workspace_id, options)
      return mapWorkspace(this.store.get('SELECT * FROM workspaces WHERE workspace_id = ?', existing.workspace_id))
    }
    const digest = createHash('sha256').update(`${subscriberId}:${hostWorkspaceId}`, 'utf8').digest('hex').slice(0, 24)
    return this.createWorkspace({ subscriberId, workspaceId: `ws_shared_${digest}`, displayName, rootPath, createDirectory: false, metadata: { source: 'host', hostWorkspaceId } }, options)
  }

  async createHostWorkspace(input = {}, options = {}) {
    this._requireSystemActor(options)
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    this._requireSubscriber(subscriberId)
    const displayName = text(input.displayName ?? input.name ?? '订阅工作区', '工作区名称', 300)
    const suffix = createHash('sha256').update(displayName, 'utf8').digest('hex').slice(0, 8)
    const rootPath = this._workspaceDecision(input.rootPath ?? input.path ?? join(this.defaultWorkspaceRoot, `${subscriberId}-${suffix}`))
    try { mkdirSync(rootPath, { recursive: true, mode: 0o700 }) } catch (error) { throw new SubscriptionError('WORKSPACE_CREATE_FAILED', `无法创建工作区目录: ${error.message}`) }
    let registry = this.workspaceRegistry
    try { registry = registry || this.workspaceRegistryResolver?.() } catch { registry = null }
    if (typeof registry?.create !== 'function') throw new SubscriptionError('HOST_WORKSPACE_REGISTRY_UNAVAILABLE', '大神工作区服务不可用')
    let existing
    try { existing = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(rootPath) : registry.list?.().find((item) => String(item?.path ?? item?.rootPath ?? '') === rootPath) } catch { existing = null }
    const hostWorkspace = existing || await registry.create(rootPath, displayName)
    const hostWorkspaceId = text(hostWorkspace?.id ?? hostWorkspace?.workspaceId, '大神工作区 ID', 500)
    const mirrored = this.shareHostWorkspace({ subscriberId, hostWorkspaceId }, options)
    this._audit('workspace.host-create', { subscriberId, details: { workspaceId: mirrored.workspaceId, hostWorkspaceId, displayName, reused: Boolean(existing) } })
    return { ...mirrored, hostWorkspaceId, source: 'shared', reused: Boolean(existing) }
  }

  _autoSelectIfReady(subscriberId, tx = this.store) {
    if (tx.get('SELECT subscriber_id FROM selections WHERE subscriber_id = ?', subscriberId)) return false
    const mode = tx.get('SELECT resource_id FROM entitlements WHERE subscriber_id = ? AND kind = ? AND status = ? ORDER BY created_at ASC LIMIT 1', subscriberId, 'mode', 'active')
    const workspace = tx.get('SELECT resource_id FROM entitlements WHERE subscriber_id = ? AND kind = ? AND status = ? ORDER BY created_at ASC LIMIT 1', subscriberId, 'workspace', 'active')
    const model = tx.get('SELECT provider,model FROM entitlements WHERE subscriber_id = ? AND kind = ? AND status = ? ORDER BY created_at ASC LIMIT 1', subscriberId, 'model', 'active')
    const efforts = tx.all('SELECT resource_id FROM entitlements WHERE subscriber_id = ? AND kind = ? AND status = ? ORDER BY created_at ASC', subscriberId, 'effort', 'active')
    const supportedEfforts = this.catalogSnapshot?.models?.find((item) => item.resourceId === `${model?.provider}/${model?.model}`)?.efforts || []
    const effort = efforts.find((item) => !supportedEfforts.length || supportedEfforts.includes(item.resource_id))
    if (!mode?.resource_id || !workspace?.resource_id || !model?.provider || !model?.model || !effort?.resource_id) return false
    tx.run('INSERT INTO selections(subscriber_id,mode_id,workspace_id,model_provider,model_id,effort_id,revision,updated_at) VALUES (?,?,?,?,?,?,?,?)', subscriberId, mode.resource_id, workspace.resource_id, model.provider, model.model, effort.resource_id, 1, this._time())
    return true
  }

  grantEntitlement(input = {}, options = {}) {
    this._requireSystemActor(options)
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    this._requireSubscriber(subscriberId)
    const kind = parseEntitlementKind(input.kind)
    let resourceId = input.resourceId ?? input.id
    let provider = optionalText(input.provider, 200)
    let model = optionalText(input.model, 300)
    if (kind === 'model') {
      const parsed = input.provider && input.model && typeof input.model === 'string'
        ? parseModel({ provider: input.provider, model: input.model })
        : parseModel(input.model ?? resourceId, input.provider)
      resourceId = parsed.resourceId; provider = parsed.provider; model = parsed.model
    }
    resourceId = text(resourceId, '授权资源 ID', 500)
    this._validateCatalogEntitlement(kind, kind === 'model' ? resourceId : resourceId)
    const inputMetadata = input.metadata === undefined ? {} : sanitizeMetadata(input.metadata)
    if (kind === 'model' && input.usageMetered !== undefined) inputMetadata.usageMetered = input.usageMetered === true
    if (kind === 'model' && !usageMeteredFlag({ ...inputMetadata, usageMetered: input.usageMetered })) throw new SubscriptionError('MODEL_USAGE_UNMETERED', '没有可靠 usage 计量的模型不能分配给订阅者')
    if (kind === 'workspace') {
      const workspace = this.store.get('SELECT * FROM workspaces WHERE workspace_id = ? AND status = ?', resourceId, 'active')
      if (!workspace) throw new SubscriptionError('WORKSPACE_NOT_FOUND', '工作区不存在或不可用')
    }
    if (kind === 'shrimp' && !input.displayName && !input.name) throw new SubscriptionError('SHRIMP_DISPLAY_NAME_REQUIRED', '虾授权必须记录正式 display_name')
    const displayName = text(input.displayName ?? input.name ?? resourceId, '授权显示名', 500)
    const entitlementId = input.entitlementId ? id(input.entitlementId, '授权 ID') : `ent_${randomUUID()}`
    const entitlementStatus = kind === 'shrimp' && input.remoteAcknowledged !== true && options.remoteAcknowledged !== true ? 'pending' : 'active'
    const at = this._time()
    try {
      this.store.transaction(() => {
        const existing = this.store.get('SELECT * FROM entitlements WHERE subscriber_id = ? AND kind = ? AND resource_id = ?', subscriberId, kind, resourceId)
        let storedEntitlementId = entitlementId
        if (existing) {
          storedEntitlementId = existing.entitlement_id
          this._checkExpectedRevision(existing, options.expectedRevision ?? input.expectedRevision, '授权')
          const metadata = input.metadata === undefined ? rowMetadata(existing) : inputMetadata
          const result = this.store.run('UPDATE entitlements SET display_name = ?, provider = ?, model = ?, status = ?, metadata_json = ?, revision = revision + 1, updated_at = ? WHERE entitlement_id = ? AND revision = ?', displayName, provider, model, entitlementStatus, jsonText(metadata), at, existing.entitlement_id, Number(existing.revision))
          if (!result.changes) throw new SubscriptionError('CAS_CONFLICT', '授权已变化，请重新读取后提交', undefined, 409)
        } else {
          this.store.run('INSERT INTO entitlements(entitlement_id,subscriber_id,kind,resource_id,display_name,provider,model,status,metadata_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', entitlementId, subscriberId, kind, resourceId, displayName, provider, model, entitlementStatus, jsonText(inputMetadata), 1, at, at)
        }
        if (kind === 'shrimp' && entitlementStatus === 'pending') {
          this.store.run('INSERT OR IGNORE INTO outbox(outbox_id,kind,aggregate_id,idempotency_key,payload_json,status,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', `out_${randomUUID()}`, 'shrimptank.pipeline.grant', subscriberId, `shrimp-grant:${storedEntitlementId}`, jsonText({ subscriberId, entitlementId: storedEntitlementId, resourceId, displayName }), 'pending', 0, at, at)
        }
        this._autoSelectIfReady(subscriberId)
        this._recomputeStatus(subscriberId)
        this._queueSubscriberSync(subscriberId, 'entitlement.grant')
        this._audit('entitlement.grant', { subscriberId, details: { entitlementId, kind, resourceId, displayName } })
      })
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) throw new SubscriptionError('ENTITLEMENT_EXISTS', '该授权已存在')
      throw error
    }
    return mapEntitlement(this.store.get('SELECT * FROM entitlements WHERE subscriber_id = ? AND kind = ? AND resource_id = ?', subscriberId, kind, resourceId))
  }

  grantEntitlements(input = {}, options = {}) {
    const items = Array.isArray(input) ? input : Array.isArray(input.entitlements) ? input.entitlements : [input]
    return items.map((item) => this.grantEntitlement(item, options))
  }

  revokeEntitlement(input = {}, options = {}) {
    this._requireSystemActor(options)
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    const entitlementId = input.entitlementId || input.id
    let row = entitlementId ? this.store.get('SELECT * FROM entitlements WHERE entitlement_id = ? AND subscriber_id = ?', id(entitlementId, '授权 ID'), subscriberId) : null
    if (!row && input.kind && input.resourceId) row = this.store.get('SELECT * FROM entitlements WHERE subscriber_id = ? AND kind = ? AND resource_id = ?', subscriberId, parseEntitlementKind(input.kind), text(input.resourceId, '资源 ID', 500))
    if (!row) throw new SubscriptionError('ENTITLEMENT_NOT_FOUND', '授权不存在')
    this._checkExpectedRevision(row, options.expectedRevision ?? input.expectedRevision, '授权')
    this.store.transaction(() => {
      const result = this.store.run('UPDATE entitlements SET status = ?, revision = revision + 1, updated_at = ? WHERE entitlement_id = ? AND revision = ?', 'revoked', this._time(), row.entitlement_id, Number(row.revision))
      if (!result.changes) throw new SubscriptionError('CAS_CONFLICT', '授权已变化，请重新读取后提交', undefined, 409)
      if (row.kind === 'shrimp') this.store.run('INSERT OR IGNORE INTO outbox(outbox_id,kind,aggregate_id,idempotency_key,payload_json,status,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', `out_${randomUUID()}`, 'shrimptank.pipeline.revoke', subscriberId, `shrimp-revoke:${row.entitlement_id}:${Number(row.revision) + 1}`, jsonText({ subscriberId, entitlementId: row.entitlement_id, resourceId: row.resource_id, displayName: row.display_name }), 'pending', 0, this._time(), this._time())
      this._recomputeStatus(subscriberId)
      this._queueSubscriberSync(subscriberId, 'entitlement.revoke')
      this._audit('entitlement.revoke', { subscriberId, details: { entitlementId: row.entitlement_id, kind: row.kind, resourceId: row.resource_id } })
    })
    return mapEntitlement(this.store.get('SELECT * FROM entitlements WHERE entitlement_id = ?', row.entitlement_id))
  }

  activateEntitlement(input = {}, options = {}) {
    this._requireSystemActor(options)
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    const entitlementId = id(input.entitlementId ?? input.id, '授权 ID')
    const row = this.store.get('SELECT * FROM entitlements WHERE entitlement_id = ? AND subscriber_id = ?', entitlementId, subscriberId)
    if (!row) throw new SubscriptionError('ENTITLEMENT_NOT_FOUND', '授权不存在')
    this._checkExpectedRevision(row, options.expectedRevision ?? input.expectedRevision, '授权')
    const receipt = sanitizeMetadata(input.receipt)
    this.store.transaction(() => {
      const result = this.store.run('UPDATE entitlements SET status = ?, metadata_json = ?, revision = revision + 1, updated_at = ? WHERE entitlement_id = ? AND revision = ?', 'active', jsonText({ ...rowMetadata(row), remoteReceipt: { accountId: optionalText(receipt.accountId ?? receipt.account_id, 300), userId: optionalText(receipt.userId ?? receipt.user_id, 300) } }), this._time(), entitlementId, Number(row.revision))
      if (!result.changes) throw new SubscriptionError('CAS_CONFLICT', '授权已变化，请重新读取后提交', undefined, 409)
      const pending = this.store.get('SELECT outbox_id FROM outbox WHERE idempotency_key = ?', `shrimp-grant:${entitlementId}`)
      if (pending) this.store.run('UPDATE outbox SET status = ?, updated_at = ? WHERE outbox_id = ?', 'completed', this._time(), pending.outbox_id)
      this._audit('entitlement.remote-activate', { subscriberId, details: { entitlementId, receipt: { accountId: receipt.accountId ?? receipt.account_id ?? null, userId: receipt.userId ?? receipt.user_id ?? null } } })
    })
    return mapEntitlement(this.store.get('SELECT * FROM entitlements WHERE entitlement_id = ?', entitlementId))
  }

  markEntitlementRemoteActive(input = {}, options = {}) { return this.activateEntitlement(input, options) }

  revokeEntitlements(input = {}, options = {}) {
    const items = Array.isArray(input) ? input : Array.isArray(input.entitlements) ? input.entitlements : [input]
    return items.map((item) => this.revokeEntitlement(item, options))
  }

  listEntitlements(subscriberId, options = {}) {
    if (subscriberId && typeof subscriberId === 'object') {
      options = subscriberId
      subscriberId = options.subscriberId
    }
    const rows = this.store.all('SELECT * FROM entitlements WHERE subscriber_id = ? ORDER BY kind, created_at ASC', id(subscriberId, '订阅者 ID')).map(mapEntitlement)
    if (options.forSubscriber === true) return rows.filter((row) => row.kind !== 'shrimp').map(({ entitlementId, subscriberId: owner, kind, resourceId, displayName, provider, model, status, revision }) => ({ entitlementId, subscriberId: owner, kind, resourceId, displayName, provider, model, status, revision }))
    return rows
  }

  listAllowedEntitlements(subscriberId) { return this.listEntitlements(subscriberId, { forSubscriber: true }) }

  grantWorkspace(subscriberId, workspaceId, options = {}) {
    if (subscriberId && typeof subscriberId === 'object') {
      const input = subscriberId
      options = workspaceId || {}
      subscriberId = input.subscriberId
      workspaceId = input.workspaceId
      return this.grantEntitlement({ ...input, kind: 'workspace', resourceId: workspaceId, displayName: input.displayName || this.getWorkspace(workspaceId)?.displayName || workspaceId }, options)
    }
    return this.grantEntitlement({ subscriberId, kind: 'workspace', resourceId: workspaceId, displayName: options.displayName || this.getWorkspace(workspaceId)?.displayName || workspaceId }, options)
  }

  revokeWorkspace(subscriberId, workspaceId, options = {}) {
    if (subscriberId && typeof subscriberId === 'object') {
      const input = subscriberId
      options = workspaceId || {}
      subscriberId = input.subscriberId
      workspaceId = input.workspaceId
    }
    return this.revokeEntitlement({ subscriberId, kind: 'workspace', resourceId: workspaceId }, options)
  }

  _hasEntitlement(subscriberId, kind, resourceId) {
    return this.store.get('SELECT * FROM entitlements WHERE subscriber_id = ? AND kind = ? AND resource_id = ? AND status = ?', subscriberId, kind, resourceId, 'active')
  }

  _selectionModelResource(selection) { return selection?.model_provider && selection?.model_id ? `${selection.model_provider}/${selection.model_id}` : null }

  getSelections(subscriberId) {
    if (subscriberId && typeof subscriberId === 'object') subscriberId = subscriberId.subscriberId
    return mapSelection(this.store.get('SELECT * FROM selections WHERE subscriber_id = ?', id(subscriberId, '订阅者 ID')))
  }

  listSelections(subscriberId) { return this.getSelections(subscriberId) }

  setSelection(subscriberId, input = {}, options = {}) {
    if (subscriberId && typeof subscriberId === 'object') {
      const value = subscriberId
      const kind = String(value.kind || '').toLowerCase()
      const selected = value.value ?? value.resourceId ?? value.id
      const patch = kind === 'mode' ? { modeId: selected } : kind === 'workspace' ? { workspaceId: selected } : kind === 'model' ? { model: selected } : kind === 'effort' || kind === 'reasoning' ? { effortId: selected } : value.selection || {}
      return this.setSubscriberSelections(value.subscriberId, patch, { ...value, ...options, actorRole: ROLE_SUBSCRIBER, accountId: value.accountId || options.accountId, senderStaffId: value.senderStaffId || value.userId || options.senderStaffId || options.userId })
    }
    return this.setSelections(subscriberId, input, options)
  }

  setSubscriberSelections(subscriberId, input = {}, options = {}) {
    return this.setSelections(subscriberId, input, { ...options, actorRole: ROLE_SUBSCRIBER, senderStaffId: options.senderStaffId || options.userId || options.actorId })
  }

  selectMode(subscriberId, modeId, options = {}) {
    if (subscriberId && typeof subscriberId === 'object') return this.setSelection({ ...subscriberId, kind: 'mode', value: subscriberId.value ?? subscriberId.modeId ?? subscriberId.resourceId }, modeId || {})
    return this.setSubscriberSelections(subscriberId, { modeId }, options)
  }

  selectWorkspace(subscriberId, workspaceId, options = {}) {
    if (subscriberId && typeof subscriberId === 'object') return this.setSelection({ ...subscriberId, kind: 'workspace', value: subscriberId.value ?? subscriberId.workspaceId ?? subscriberId.resourceId }, workspaceId || {})
    return this.setSubscriberSelections(subscriberId, { workspaceId }, options)
  }

  selectModel(subscriberId, model, options = {}) {
    if (subscriberId && typeof subscriberId === 'object') return this.setSelection({ ...subscriberId, kind: 'model', value: subscriberId.value ?? subscriberId.model ?? subscriberId.resourceId }, model || {})
    return this.setSubscriberSelections(subscriberId, { model }, options)
  }

  selectEffort(subscriberId, effortId, options = {}) {
    if (subscriberId && typeof subscriberId === 'object') return this.setSelection({ ...subscriberId, kind: 'effort', value: subscriberId.value ?? subscriberId.effortId ?? subscriberId.resourceId }, effortId || {})
    return this.setSubscriberSelections(subscriberId, { effortId }, options)
  }

  setSelections(subscriberId, input = {}, options = {}) {
    const actor = actorFrom(options)
    if (actor.role === ROLE_SUBSCRIBER) {
      const inbound = this.authorizeInbound({ accountId: options.accountId, senderStaffId: options.senderStaffId || options.userId || options.actorId, conversationType: 'direct', at: options.at })
      if (!inbound.allowed || inbound.subscriberId !== subscriberId) throw new SubscriptionError('SUBSCRIBER_SELECTION_UNAUTHORIZED', '订阅者无权修改该账户选择', undefined, 403)
      if (!inbound.taskAllowed) throw new SubscriptionError(inbound.workday?.reason || 'NON_WORKDAY', '当前不是允许使用的工作日')
    } else this._requireSystemActor(options)
    const subscriber = this._requireSubscriber(subscriberId)
    const current = this.store.get('SELECT * FROM selections WHERE subscriber_id = ?', subscriberId)
    this._checkExpectedRevision(current || { revision: 1 }, options.expectedRevision ?? input.expectedRevision, '选择')
    const modeId = input.modeId ?? input.mode ?? current?.mode_id ?? null
    const workspaceId = input.workspaceId ?? input.workspace ?? current?.workspace_id ?? null
    const effortId = input.effortId ?? input.effort ?? current?.effort_id ?? null
    const modelInput = input.model ?? (input.modelProvider || input.modelId ? { provider: input.modelProvider, model: input.modelId } : current?.model_provider ? { provider: current.model_provider, model: current.model_id } : null)
    const model = modelInput ? parseModel(modelInput) : null
    if (!modeId || !this._hasEntitlement(subscriberId, 'mode', text(modeId, '模式 ID', 500))) throw new SubscriptionError('MODE_NOT_ALLOWED', '该模式未授权')
    if (!workspaceId || !this._hasEntitlement(subscriberId, 'workspace', text(workspaceId, '工作区 ID', 500))) throw new SubscriptionError('WORKSPACE_NOT_ALLOWED', '该工作区未授权')
    if (!model || !this._hasEntitlement(subscriberId, 'model', model.resourceId)) throw new SubscriptionError('MODEL_NOT_ALLOWED', '该模型未授权')
    if (!effortId || !this._hasEntitlement(subscriberId, 'effort', text(effortId, '推理强度', 100))) throw new SubscriptionError('EFFORT_NOT_ALLOWED', '该推理强度未授权')
    const supportedEfforts = this.catalogSnapshot?.models?.find((item) => item.resourceId === model.resourceId)?.efforts || []
    if (supportedEfforts.length && !supportedEfforts.includes(String(effortId))) throw new SubscriptionError('EFFORT_NOT_SUPPORTED', '所选模型不支持该推理强度')
    const workspace = this.store.get('SELECT * FROM workspaces WHERE workspace_id = ? AND status = ?', workspaceId, 'active')
    if (!workspace) throw new SubscriptionError('WORKSPACE_NOT_FOUND', '工作区不存在或不可用')
    const at = this._time()
    this.store.transaction(() => {
      if (current) {
        const result = this.store.run('UPDATE selections SET mode_id = ?, workspace_id = ?, model_provider = ?, model_id = ?, effort_id = ?, revision = revision + 1, updated_at = ? WHERE subscriber_id = ? AND revision = ?', text(modeId, '模式 ID', 500), text(workspaceId, '工作区 ID', 500), model.provider, model.model, text(effortId, '推理强度', 100), at, subscriberId, Number(current.revision))
        if (!result.changes) throw new SubscriptionError('CAS_CONFLICT', '选择已变化，请重新读取后提交', undefined, 409)
      } else {
        this.store.run('INSERT INTO selections(subscriber_id,mode_id,workspace_id,model_provider,model_id,effort_id,revision,updated_at) VALUES (?,?,?,?,?,?,?,?)', subscriberId, text(modeId, '模式 ID', 500), text(workspaceId, '工作区 ID', 500), model.provider, model.model, text(effortId, '推理强度', 100), 1, at)
      }
      this._recomputeStatus(subscriberId)
      this._queueSubscriberSync(subscriberId, 'selection.set')
      this._audit('selection.set', { subscriberId, details: { modeId, workspaceId, model: model.resourceId, effortId } })
    })
    return this.getSelections(subscriberId)
  }

  beginBindingChallenge(subscriberId, input = {}, options = {}) {
    if (subscriberId && typeof subscriberId === 'object') {
      const value = subscriberId
      options = input || {}
      subscriberId = value.subscriberId
      input = value
    }
    this._requireSystemActor(options)
    this._requireSubscriber(subscriberId)
    const accountId = input.accountId ? id(input.accountId, '机器人账户 ID') : this.store.get('SELECT account_id FROM robot_accounts WHERE subscriber_id = ?', subscriberId)?.account_id
    if (accountId && !this.store.get('SELECT account_id FROM robot_accounts WHERE account_id = ? AND subscriber_id = ?', accountId, subscriberId)) throw new SubscriptionError('ROBOT_ACCOUNT_NOT_FOUND', '机器人账户不属于该订阅者')
    const ttlMs = Math.min(number(input.ttlMs ?? 10 * 60_000, '绑定挑战有效期', { min: 1_000, max: 30 * 60_000 }), 30 * 60_000)
    const challengeId = `bind_${randomUUID()}`
    const challengeToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.parse(this._time()) + ttlMs).toISOString()
    const at = this._time()
    this.store.transaction(() => {
      this.store.run(`UPDATE binding_challenges SET status = 'superseded', updated_at = ? WHERE subscriber_id = ? AND status = 'pending'`, at, subscriberId)
      this.store.run('INSERT INTO binding_challenges(challenge_id,subscriber_id,account_id,token_hash,status,expires_at,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', challengeId, subscriberId, accountId, hashToken(challengeToken), 'pending', expiresAt, jsonText(sanitizeMetadata(input.metadata)), at, at)
      this.store.run('INSERT INTO outbox(outbox_id,kind,aggregate_id,idempotency_key,payload_json,status,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', `out_${randomUUID()}`, 'dingtalk.robot.provision', subscriberId, `binding:${challengeId}`, jsonText({ challengeId, subscriberId, accountId, brand: BRAND }), 'pending', 0, at, at)
      this._audit('binding.begin', { subscriberId, details: { challengeId, accountId, expiresAt } })
    })
    return { challengeId, challengeToken, expiresAt, qrPayload: `dsh-dingtalk-binding:${challengeId}.${challengeToken}`, brand: BRAND }
  }

  createBindingChallenge(subscriberId, input = {}, options = {}) { return this.beginBindingChallenge(subscriberId, input, options) }

  _challengeByInput(input) {
    const challengeId = input.challengeId ? id(input.challengeId, '绑定挑战 ID') : null
    const token = input.challengeToken ?? input.token
    if (!challengeId || !token) throw new SubscriptionError('BINDING_CHALLENGE_INVALID', '绑定挑战缺少 ID 或 token')
    const row = this.store.get('SELECT * FROM binding_challenges WHERE challenge_id = ?', challengeId)
    if (!row) throw new SubscriptionError('BINDING_CHALLENGE_NOT_FOUND', '绑定挑战不存在')
    return { row, token: String(token) }
  }

  completeBindingChallenge(input = {}, options = {}) {
    this._requireSystemActor(options)
    const { row, token } = this._challengeByInput(input)
    if (!constantTimeHexEqual(row.token_hash, hashToken(token))) throw new SubscriptionError('BINDING_CHALLENGE_INVALID', '绑定挑战无效')
    return this._finishBinding(row, input)
  }

  _finishBinding(row, input = {}) {
    const now = new Date(this._time()).getTime()
    if (row.status !== 'pending') throw new SubscriptionError('BINDING_CHALLENGE_USED', '绑定挑战已使用或失效')
    if (Date.parse(row.expires_at) <= now) {
      this.store.run('UPDATE binding_challenges SET status = ?, updated_at = ? WHERE challenge_id = ?', 'expired', this._time(), row.challenge_id)
      throw new SubscriptionError('BINDING_CHALLENGE_EXPIRED', '绑定挑战已过期')
    }
    const accountId = input.accountId ? id(input.accountId, '机器人账户 ID') : row.account_id
    const account = this.store.get('SELECT * FROM robot_accounts WHERE account_id = ? AND subscriber_id = ?', accountId, row.subscriber_id)
    if (!account) throw new SubscriptionError('ROBOT_ACCOUNT_NOT_FOUND', '绑定机器人账户不存在')
    const staffId = text(input.senderStaffId ?? input.userId ?? input.staffId, '钉钉身份', 512)
    const identityHmac = this._identity(staffId)
    const duplicate = this.store.get('SELECT subscriber_id FROM subscribers WHERE identity_hmac = ? AND subscriber_id != ?', identityHmac, row.subscriber_id)
    if (duplicate) throw new SubscriptionError('IDENTITY_ALREADY_BOUND', '该钉钉身份已绑定其他订阅账户')
    const at = this._time()
    this.store.transaction(() => {
      const result = this.store.run('UPDATE binding_challenges SET status = ?, consumed_at = ?, updated_at = ? WHERE challenge_id = ? AND status = ?', 'consumed', at, at, row.challenge_id, 'pending')
      if (!result.changes) throw new SubscriptionError('BINDING_CHALLENGE_USED', '绑定挑战已被其他请求消费')
      this.store.run('UPDATE subscribers SET identity_hmac = ?, status = ?, revision = revision + 1, updated_at = ? WHERE subscriber_id = ?', identityHmac, SUBSCRIBER_STATUSES.WAITING_WORKSPACE, at, row.subscriber_id)
      this._recomputeStatus(row.subscriber_id)
      this._audit('binding.complete', { subscriberId: row.subscriber_id, actorId: staffId, details: { challengeId: row.challenge_id, accountId } })
    })
    return { ok: true, challenge: mapChallenge(this.store.get('SELECT * FROM binding_challenges WHERE challenge_id = ?', row.challenge_id)), subscriber: this.getSubscriber(row.subscriber_id), account: this.getRobotAccount(accountId) }
  }

  confirmPendingBinding(input = {}) {
    const conversationType = normalizeConversationType(input.conversationType ?? input.message?.conversationType)
    if (conversationType !== 'direct') throw new SubscriptionError('DIRECT_CHAT_REQUIRED', '订阅机器人只允许私聊绑定', undefined, 403)
    const accountId = id(input.accountId, '机器人账户 ID')
    const challengeId = input.challengeId ? id(input.challengeId, '绑定挑战 ID') : null
    const row = challengeId
      ? this.store.get('SELECT * FROM binding_challenges WHERE challenge_id = ? AND account_id = ? AND status = ?', challengeId, accountId, 'pending')
      : this.store.get('SELECT * FROM binding_challenges WHERE account_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1', accountId, 'pending')
    if (!row) throw new SubscriptionError('BINDING_CHALLENGE_NOT_FOUND', '当前没有可确认的绑定挑战')
    const result = this._finishBinding(row, {
      ...input,
      accountId,
      senderStaffId: input.senderStaffId ?? input.staffId ?? input.userId ?? input.message?.senderStaffId,
    })
    return { ...result, activated: result.subscriber?.status === SUBSCRIBER_STATUSES.ACTIVE, status: result.subscriber?.status, kind: 'bound' }
  }

  completeBinding(input = {}, options = {}) {
    if (typeof input === 'string') input = { challengeId: input, challengeToken: options }
    return this.completeBindingChallenge(input, options)
  }

  consumeBindingChallenge(input = {}, options = {}, maybeOptions = {}) {
    if (typeof input === 'string') {
      input = { challengeId: input, challengeToken: options, ...(maybeOptions || {}) }
      options = maybeOptions
    }
    return this.completeBindingChallenge(input, options)
  }

  authorizeInbound(input = {}) {
    const accountId = id(input.accountId, '机器人账户 ID')
    const conversationType = normalizeConversationType(input.conversationType)
    if (conversationType !== 'direct') return { allowed: false, code: 'DIRECT_CHAT_REQUIRED', reason: '订阅机器人只允许私聊。' }
    const account = this.store.get('SELECT * FROM robot_accounts WHERE account_id = ?', accountId)
    if (!account) return { allowed: false, code: 'ROBOT_ACCOUNT_NOT_FOUND', reason: '机器人账户未绑定。' }
    const subscriber = this.store.get('SELECT * FROM subscribers WHERE subscriber_id = ?', account.subscriber_id)
    if (!subscriber || !subscriber.identity_hmac) {
      const challenge = subscriber ? this.store.get('SELECT challenge_id,expires_at FROM binding_challenges WHERE subscriber_id = ? AND account_id = ? AND status = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1', subscriber.subscriber_id, accountId, 'pending', this._time()) : null
      if (challenge) return { allowed: false, kind: 'pending-binding', status: 'pending-binding', code: 'SUBSCRIBER_BINDING_PENDING', reason: '订阅账户等待私聊确认绑定。', challengeId: challenge.challenge_id, expiresAt: challenge.expires_at }
      return { allowed: false, code: 'SUBSCRIBER_NOT_BOUND', reason: '订阅账户尚未完成绑定。' }
    }
    let identity
    try { identity = this._identity(input.senderStaffId) } catch { return { allowed: false, code: 'IDENTITY_INVALID', reason: '钉钉身份无效。' } }
    if (!constantTimeHexEqual(identity, subscriber.identity_hmac)) return { allowed: false, code: 'IDENTITY_MISMATCH', reason: '当前钉钉身份未绑定此机器人。' }
    if (subscriber.status === SUBSCRIBER_STATUSES.SUSPENDED) return { allowed: false, code: 'SUBSCRIBER_SUSPENDED', reason: '订阅账户已暂停。' }
    if (subscriber.status === SUBSCRIBER_STATUSES.REVOKED) return { allowed: false, code: 'SUBSCRIBER_REVOKED', reason: '订阅账户已撤销。' }
    if (account.status !== 'active' || account.brand_status !== 'verified') return { allowed: false, code: 'ROBOT_NOT_READY', reason: '机器人尚未完成配置。' }
    const policy = this.resolveRuntimePolicy(subscriber.subscriber_id)
    if (!policy.workspaceRoot) return { allowed: false, code: 'WORKSPACE_REQUIRED', reason: '管理员尚未创建订阅工作区。' }
    if (subscriber.status !== SUBSCRIBER_STATUSES.ACTIVE) return { allowed: false, code: 'SUBSCRIBER_NOT_READY', reason: '管理员尚未完成订阅配置。' }
    const workday = this.workdayStatus(input.at || this._time())
    this._audit('inbound.authorize', { subscriberId: subscriber.subscriber_id, actorId: input.senderStaffId, details: { accountId, conversationType } })
    return { allowed: true, role: ROLE_SUBSCRIBER, subscriberId: subscriber.subscriber_id, accountId, policy, workday, taskAllowed: workday.known && workday.allowed, readOnlyCommandsAllowed: ['status', 'quota', 'help'] }
  }

  resumeRuntime(input = {}) {
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    const auth = this.authorizeInbound({ accountId: input.accountId, senderStaffId: input.senderStaffId || input.userId, conversationType: 'direct', at: input.at })
    if (!auth.allowed) return auth
    const quota = this.quotaStatus(subscriberId, { at: input.at || this._time() })
    if (!quota.allowed) return { allowed: false, code: quota.reason, reason: quota.reason === 'QUOTA_EXHAUSTED' ? '本周 Token 额度已用完，请等待下个周期或联系管理员重置。' : '当前不允许恢复运行。', quota, policy: auth.policy }
    const current = this._subscriberRow(subscriberId)
    if (current?.status === SUBSCRIBER_STATUSES.QUOTA_EXHAUSTED) {
      this.store.run('UPDATE subscribers SET status = ?, revision = revision + 1, updated_at = ? WHERE subscriber_id = ?', SUBSCRIBER_STATUSES.ACTIVE, this._time(), subscriberId)
    }
    return { allowed: true, code: null, subscriberId, accountId: auth.accountId, quota, policy: auth.policy }
  }

  resumeSubscriberRuntime(input = {}) { return this.resumeRuntime(input) }

  _entitlementOptions(subscriberId, kind) {
    return this.store.all('SELECT * FROM entitlements WHERE subscriber_id = ? AND kind = ? AND status = ? ORDER BY display_name ASC', subscriberId, kind, 'active').map((row) => {
      const item = mapEntitlement(row)
      return kind === 'shrimp' ? { entitlementId: item.entitlementId, resourceId: item.resourceId } : { entitlementId: item.entitlementId, resourceId: item.resourceId, displayName: item.displayName, provider: item.provider, model: item.model, usageMetered: kind === 'model' && usageMeteredFlag(item.metadata) }
    })
  }

  resolveRuntimePolicy(subscriberId) {
    const row = this._requireSubscriber(subscriberId)
    const account = this.store.get('SELECT * FROM robot_accounts WHERE subscriber_id = ?', subscriberId)
    const selection = this.store.get('SELECT * FROM selections WHERE subscriber_id = ?', subscriberId)
    const selectedWorkspace = selection?.workspace_id ? this.store.get('SELECT * FROM workspaces WHERE workspace_id = ? AND status = ?', selection.workspace_id, 'active') : null
    const selectedWorkspaceMetadata = selectedWorkspace ? rowMetadata(selectedWorkspace) : {}
    const allowedWorkspaces = this._entitlementOptions(subscriberId, 'workspace').map((item) => {
      const workspace = this.store.get('SELECT * FROM workspaces WHERE workspace_id = ? AND status = ?', item.resourceId, 'active')
      return workspace ? { entitlementId: item.entitlementId, workspaceId: workspace.workspace_id, displayName: workspace.display_name } : null
    }).filter(Boolean)
    const selectedMode = selection?.mode_id ? this.store.get('SELECT display_name FROM entitlements WHERE subscriber_id = ? AND kind = ? AND resource_id = ? AND status = ?', subscriberId, 'mode', selection.mode_id, 'active') : null
    const selectedEffort = selection?.effort_id ? this.store.get('SELECT display_name FROM entitlements WHERE subscriber_id = ? AND kind = ? AND resource_id = ? AND status = ?', subscriberId, 'effort', selection.effort_id, 'active') : null
    const selectedModel = selection?.model_provider && selection?.model_id ? this.store.get('SELECT display_name FROM entitlements WHERE subscriber_id = ? AND kind = ? AND resource_id = ? AND status = ?', subscriberId, 'model', `${selection.model_provider}/${selection.model_id}`, 'active') : null
    return {
      role: ROLE_SUBSCRIBER,
      subscriberId,
      accountId: account?.account_id || null,
      status: row.status,
      active: row.status === SUBSCRIBER_STATUSES.ACTIVE,
      workspaceRoot: selectedWorkspace?.root_path || null,
      workspaceId: selectedWorkspace?.workspace_id || null,
      hostWorkspaceId: selectedWorkspaceMetadata.hostWorkspaceId || null,
      workspaceDisplayName: selectedWorkspace?.display_name || null,
      modeDisplayName: selectedMode?.display_name || null,
      modelDisplayName: selectedModel?.display_name || null,
      effortDisplayName: selectedEffort?.display_name || null,
      selected: mapSelection(selection),
      allowedModes: this._entitlementOptions(subscriberId, 'mode'),
      allowedWorkspaces,
      allowedModels: this._entitlementOptions(subscriberId, 'model'),
      allowedEfforts: this._entitlementOptions(subscriberId, 'effort'),
      allowedShrimpIds: this._entitlementOptions(subscriberId, 'shrimp').map((item) => item.resourceId),
      shrimp: { exactDisplayNameRequired: true, discoveryAllowed: false, aliasAllowed: false, slugAllowed: false },
      canReadCore: false,
      canModifyCore: false,
      canCreateCapability: false,
      canInstallCapability: false,
      canResetQuota: false,
      canUseGroupChat: false,
      pathPolicy: { dshRoot: this.dshRoot, shrimpRoot: this.shrimpRoot, appRoot: this.appRoot, credentialsRoot: join(this.dshRoot, 'private') },
    }
  }

  subscriberStatus(input = {}) {
    const subscriberId = id(typeof input === 'object' ? input.subscriberId : input, '订阅者 ID')
    const subscriber = this._requireSubscriber(subscriberId)
    const policy = this.resolveRuntimePolicy(subscriberId)
    const quota = this.quotaStatus(subscriberId, { at: input?.at || this._time() })
    return {
      ok: true,
      displayName: subscriber.display_name,
      status: subscriber.status,
      identityBound: Boolean(subscriber.identity_hmac),
      workspaceDisplayName: policy.workspaceDisplayName,
      modeDisplayName: policy.modeDisplayName,
      modelDisplayName: policy.modelDisplayName,
      effortDisplayName: policy.effortDisplayName,
      weeklyTokenLimit: Number(subscriber.weekly_token_limit || 0),
      usedTokens: quota.usedTokens,
      reservedTokens: quota.reservedTokens,
      remainingTokens: quota.remainingTokens,
      workday: quota.workday,
      allowed: quota.allowed,
      reason: quota.reason,
    }
  }

  getSubscriberStatus(input = {}) { return this.subscriberStatus(input) }

  status(input = {}) { return this.subscriberStatus(input) }

  isWorkingDay(input = {}) { const day = this.workdayStatus(input?.at || this._time()); return day.known && day.allowed }

  isOperationalNow(input = {}) { return this.isWorkingDay(input) }

  canUseNow(input = {}) { return this.isWorkingDay(input) }

  checkWorkday(input = {}) { return this.isWorkingDay(input) }

  getQuotaStatus(input = {}) { return this.quotaStatus(input) }

  listAuthorizedModes(input = {}) { return this.resolveRuntimePolicy(input?.subscriberId || input).allowedModes }

  listAuthorizedWorkspaces(input = {}) { return this.resolveRuntimePolicy(input?.subscriberId || input).allowedWorkspaces }

  listAuthorizedModels(input = {}) { return this.resolveRuntimePolicy(input?.subscriberId || input).allowedModels }

  listAuthorizedEfforts(input = {}) { return this.resolveRuntimePolicy(input?.subscriberId || input).allowedEfforts }

  async _catalogCall(source, names, fallback = []) {
    for (const name of names) {
      try {
        const candidate = source?.[name]
        if (typeof candidate === 'function') {
          const value = await candidate.call(source)
          if (Array.isArray(value)) return value
          if (Array.isArray(value?.items)) return value.items
          if (Array.isArray(value?.data)) return value.data
        } else if (Array.isArray(candidate)) return candidate
      } catch { /* an optional catalog must fail closed to an empty list */ }
    }
    return fallback
  }

  async listCatalog(options = {}) {
    const resolveOptional = (value, resolver) => {
      if (value) return value
      try { return typeof resolver === 'function' ? resolver() : null } catch { return null }
    }
    const presets = options.agentPresets || resolveOptional(this.agentPresets, this.agentPresetsResolver)
    const workspaceRegistry = options.workspaceRegistry || resolveOptional(this.workspaceRegistry, this.workspaceRegistryResolver)
    const llm = options.llm || resolveOptional(this.llm, this.llmResolver)
    const shrimpCatalog = options.shrimpCatalog || resolveOptional(this.shrimpCatalog, this.shrimpCatalogResolver)
    const modeRows = await this._catalogCall(presets, ['list', 'listPresets', 'listModes'], [])
    const modes = modeRows.map((item) => ({ resourceId: String(item?.id || item?.presetId || item?.resourceId || '').trim(), displayName: String(item?.displayName || item?.name || item?.title || item?.id || '').trim() })).filter((item) => item.resourceId && item.displayName)
    const registryRows = await this._catalogCall(workspaceRegistry, ['list', 'listWorkspaces', 'workspaces'], [])
    const dbWorkspaces = this.listWorkspaces()
    const hostWorkspaces = registryRows.map((item) => ({ workspaceId: String(item?.workspaceId || item?.id || item?.resourceId || '').trim(), displayName: String(item?.displayName || item?.name || item?.title || item?.id || '').trim(), rootPath: String(item?.rootPath || item?.path || '').trim(), status: item?.status || 'active', source: 'host' })).filter((item) => { try { return Boolean(item.workspaceId && item.displayName && item.status !== 'deleted' && this._workspaceDecision(item.rootPath)) } catch { return false } })
    const workspaces = [...dbWorkspaces.map((item) => ({ ...item, source: item.metadata?.source === 'host' ? 'shared' : 'subscriber' })), ...hostWorkspaces].filter((item) => item.workspaceId && item.displayName && item.status !== 'deleted')
    const uniqueWorkspaces = [...new Map(workspaces.map((item) => [item.workspaceId, item])).values()]
    const providerRows = await this._catalogCall(llm, ['listProviders', 'providers', 'list'], [])
    const models = []
    const effortSet = new Set()
    for (const providerRow of providerRows) {
      const provider = typeof providerRow === 'string' ? providerRow : providerRow?.id || providerRow?.provider || providerRow?.name
      if (!provider) continue
      let modelRows = []
      try { modelRows = await (typeof llm?.listModels === 'function' ? llm.listModels(provider) : providerRow?.models || []) } catch { modelRows = [] }
      for (const modelRow of Array.isArray(modelRows) ? modelRows : []) {
        const model = typeof modelRow === 'string' ? modelRow : modelRow?.id || modelRow?.model || modelRow?.name
        if (!model) continue
        let modelInfo
        try { modelInfo = typeof llm?.resolveModelInfo === 'function' ? await llm.resolveModelInfo(provider, model) : null } catch { modelInfo = null }
        const rawEfforts = modelRow?.reasoningEfforts || modelRow?.reasoning_efforts || modelRow?.efforts || modelRow?.capabilities?.reasoningEfforts || modelInfo?.reasoning?.efforts || []
        const efforts = [...new Set((Array.isArray(rawEfforts) ? rawEfforts : []).map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean).map((item) => String(item)))]
        efforts.forEach((item) => effortSet.add(item))
        models.push({ resourceId: `${provider}/${model}`, provider: String(provider), model: String(model), displayName: String(modelRow?.displayName || modelRow?.name || modelInfo?.name || `${provider}/${model}`), efforts, usageMetered: usageMeteredFlag(modelRow) || usageMeteredFlag(modelInfo) || this.meteredProviders.has(String(provider)) })
      }
    }
    const shrimpRows = await this._catalogCall(shrimpCatalog, ['listPublished', 'published', 'list'], [])
    const shrimps = shrimpRows.map((item) => ({ resourceId: String(item?.resourceId || item?.ref || item?.slug || item?.id || '').trim(), displayName: String(item?.displayName || item?.display_name || item?.title || item?.name || '').trim(), lifecycle: String(item?.lifecycle || item?.lifecycle_status || item?.status || 'published').toLowerCase() })).filter((item) => item.resourceId && item.displayName && (!item.lifecycle || item.lifecycle === 'published' || item.lifecycle === 'active'))
    this.shrimpCatalogCache = shrimps.map((item) => ({ resourceId: item.resourceId, display_name: item.displayName }))
    this.catalogSnapshot = { modes, workspaces: uniqueWorkspaces, models, efforts: [...effortSet].map((resourceId) => ({ resourceId, displayName: EFFORT_DISPLAY_NAMES[resourceId] || resourceId })), shrimps }
    if (!modes.length) this.catalogSnapshot.modes = this._entitlementOptionsFromDb('mode')
    if (!models.length) this.catalogSnapshot.models = this._entitlementOptionsFromDb('model')
    if (!this.catalogSnapshot.efforts.length) this.catalogSnapshot.efforts = this._entitlementOptionsFromDb('effort')
    if (!shrimps.length && options.includeGrantedShrimps === true) this.catalogSnapshot.shrimps = this._entitlementOptionsFromDb('shrimp')
    return this.catalogSnapshot
  }

  _entitlementOptionsFromDb(kind) {
    return this.store.all('SELECT resource_id,display_name,provider,model,metadata_json FROM entitlements WHERE kind = ? AND status IN (?,?) ORDER BY display_name ASC', kind, 'active', 'pending').map((row) => ({ resourceId: row.resource_id, displayName: row.display_name, provider: row.provider || null, model: row.model || null, usageMetered: kind === 'model' && usageMeteredFlag(parseJson(row.metadata_json, {})) }))
  }

  setShrimpCatalog(items = []) {
    this.shrimpCatalogCache = Array.isArray(items) ? items.map((item) => ({ resourceId: String(item?.resourceId || item?.ref || item?.slug || item?.id || '').trim(), display_name: String(item?.displayName || item?.display_name || item?.title || item?.name || '').trim() })).filter((item) => item.resourceId && item.display_name) : []
    return this.shrimpCatalogCache.slice()
  }

  _validateCatalogEntitlement(kind, resourceId) {
    const catalog = this.catalogSnapshot
    if (!catalog) return
    if (kind === 'mode' && catalog.modes.length && !catalog.modes.some((item) => item.resourceId === resourceId)) throw new SubscriptionError('MODE_NOT_FOUND', '当前模式目录中不存在该模式')
    if (kind === 'model' && catalog.models.length && !catalog.models.some((item) => item.resourceId === resourceId)) throw new SubscriptionError('MODEL_NOT_FOUND', '当前模型目录中不存在该模型')
    if (kind === 'model' && catalog.models.length && !catalog.models.some((item) => item.resourceId === resourceId && item.usageMetered === true)) throw new SubscriptionError('MODEL_USAGE_UNMETERED', '没有可靠 usage 计量的模型不能分配给订阅者')
    if (kind === 'effort' && catalog.efforts.length && !catalog.efforts.some((item) => item.resourceId === resourceId)) {
      const compatible = catalog.models.some((item) => Array.isArray(item.efforts) && item.efforts.includes(resourceId))
      if (!compatible) throw new SubscriptionError('EFFORT_NOT_SUPPORTED', '该推理强度不在当前模型能力范围内')
    }
    if (kind === 'shrimp' && this.shrimpCatalogCache.length && !this.shrimpCatalogCache.some((item) => item.resourceId === resourceId)) throw new SubscriptionError('SHRIMP_NOT_PUBLISHED', '该虾当前未在已发布目录中')
  }

  classifyProtectedContentRequest(input) { return classifyProtectedContentRequest(input) }

  evaluateToolCall(input = {}) {
    let value = input
    const tool = String(input.toolName || input.name || '').toLowerCase()
    if (tool === 'shrimp_run' && input.invocationReceiptValid !== true) {
      const args = input.arguments || input.args || {}
      let check
      try {
        check = this.peekShrimpInvocation({
          receiptId: input.invocationReceiptId || args.receiptId || args.invocationReceiptId,
          subscriberId: input.subscriberId,
          sessionId: input.sessionId || args.sessionId || input.scopeKey || args.scopeKey,
          messageId: input.messageId || args.messageId || args.turnId,
          resourceId: input.resourceId || input.shrimpResourceId || args.pipelineSlug || args.resourceId || args.slug,
        })
      } catch { check = { allowed: false } }
      value = { ...input, invocationReceiptValid: check.allowed }
    }
    return evaluateSubscriberToolCall(value)
  }

  authorizeToolCall(input = {}) { return this.evaluateToolCall(input) }

  authorizeTool(input = {}) { return this.evaluateToolCall(input) }

  toolGate(input = {}) { return this.evaluateToolCall(input) }

  recordProtectedContent(input = {}) {
    const category = optionalText(input.category, 100) || 'protected'
    const source = String(input.content ?? input.text ?? '')
    if (!source || source.length > 512_000) return { ok: false, code: 'PROTECTED_CONTENT_INVALID' }
    const normalized = source.normalize('NFKC').replace(/\s+/gu, ' ').trim()
    if (normalized.length < 16) return { ok: false, code: 'PROTECTED_CONTENT_TOO_SHORT' }
    const fingerprint = createHash('sha256').update(normalized, 'utf8').digest('hex')
    this.protectedFingerprintSources.set(fingerprint, { normalized, category, bytes: Buffer.byteLength(source, 'utf8') })
    return { ok: true, fingerprint, category, bytes: Buffer.byteLength(source, 'utf8') }
  }

  getProtectedFingerprints(options = {}) {
    const maxBytes = number(options.maxBytes ?? 512_000, '保护内容最大字节数', { min: 1_024, max: 2_000_000 })
    const paths = Array.isArray(options.paths) ? options.paths : [
      join(this.dshRoot, 'AGENTS.md'),
      join(this.dshRoot, 'config.toml'),
      join(this.dshRoot, 'settings.yaml'),
      join(this.dshRoot, '.agent-presets', 'reliable-development', 'preset.yml'),
      join(this.dshRoot, '.agent-presets', 'reliable-development', 'agent.cordis.yml'),
      join(this.dshRoot, '.agent-presets', 'avengers', 'preset.yml'),
      join(this.dshRoot, '.agent-presets', 'avengers', 'agent.cordis.yml'),
      join(this.dshRoot, 'architecture', 'dingtalk-subscriber-control.v1.json'),
    ]
    const entries = []
    for (const candidate of paths.slice(0, 64)) {
      const path = String(candidate || '')
      let resolved
      try { resolved = realpathSync(path) } catch { continue }
      const allowedRoot = [this.dshRoot, this.appRoot, this.shrimpRoot].some((root) => {
        const base = resolve(root)
        const rest = relative(base, resolved)
        return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !rest.startsWith('/'))
      })
      if (!allowedRoot) continue
      let size
      try { size = statSync(resolved).size } catch { continue }
      if (!Number.isFinite(size) || size <= 0 || size > maxBytes) continue
      let source
      try { source = readFileSync(resolved, 'utf8') } catch { continue }
      const item = this.recordProtectedContent({ content: source, category: options.category || 'protected-file' })
      if (item.ok) entries.push({ fingerprint: item.fingerprint, category: item.category, bytes: item.bytes })
    }
    for (const item of Array.isArray(options.contents) ? options.contents.slice(0, 64) : []) {
      const value = this.recordProtectedContent(item)
      if (value.ok) entries.push({ fingerprint: value.fingerprint, category: value.category, bytes: value.bytes })
    }
    const unique = [...new Map(entries.map((entry) => [entry.fingerprint, entry])).values()]
    return { ok: true, fingerprints: unique }
  }

  _protectedOverlap(value) {
    const output = String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
    if (!output) return null
    for (const [fingerprint, item] of this.protectedFingerprintSources) {
      const source = item.normalized
      if (output.includes(source) || source.includes(output) && output.length >= 64) return { fingerprint, category: item.category, ratio: 1 }
      if (output.length < 64 || source.length < 64) continue
      let matched = 0
      let total = 0
      for (let offset = 0; offset + 64 <= output.length; offset += 32) {
        total += 1
        if (source.includes(output.slice(offset, offset + 64))) matched += 1
      }
      const ratio = total ? matched / total : 0
      // Two overlapping 64-character shingles are already a meaningful
      // verbatim disclosure; shorter outputs require at least 80% overlap.
      if ((matched >= 2 && ratio >= 0.6) || ratio >= 0.8) return { fingerprint, category: item.category, ratio }
    }
    return null
  }

  guardModelOutput(value, fingerprints = []) {
    const base = detectProtectedContentDisclosure(value, fingerprints.map((item) => typeof item === 'string' ? item : item?.fingerprint).filter(Boolean))
    if (base.blocked) return base
    const overlap = this._protectedOverlap(value)
    return overlap ? { blocked: true, code: 'SUBSCRIBER_OUTPUT_PROTECTED_OVERLAP', reason: SUBSCRIBER_PROTECTED_RESPONSE } : base
  }

  getProtectedContentFingerprints(options = {}) { return this.getProtectedFingerprints(options) }

  protectedFingerprints(options = {}) { return this.getProtectedFingerprints(options).fingerprints }

  listProtectedFingerprints(options = {}) { return this.getProtectedFingerprints(options) }

  guardSubscriberOutput(value, fingerprints = []) { return this.guardModelOutput(value, fingerprints) }

  sanitizeSubscriberOutput(value, fingerprints = []) { return this.guardModelOutput(value, fingerprints) }

  exactShrimpMatch(subscriberId, message, catalog = []) {
    if (subscriberId && typeof subscriberId === 'object') {
      const input = subscriberId
      subscriberId = input.subscriberId
      message = input.text ?? input.message
      catalog = input.catalog
    }
    const subscriber = this._requireSubscriber(subscriberId)
    const normalizedMessage = String(message ?? '').normalize('NFKC').trim()
    if (!normalizedMessage || !Array.isArray(catalog)) return { ok: false, matched: false, allowed: false, requested: false, code: null, reason: null }
    const sourceCatalog = Array.isArray(catalog) && catalog.length
      ? catalog
      : this.shrimpCatalogCache.length
        ? this.shrimpCatalogCache
        : this.store.all('SELECT resource_id, display_name FROM entitlements WHERE subscriber_id = ? AND kind = ? AND status = ?', subscriber.subscriber_id, 'shrimp', 'active').map((row) => ({ resourceId: row.resource_id, display_name: row.display_name }))
    const entries = sourceCatalog.map((item) => {
      const displayName = typeof item === 'string' ? item : item?.display_name ?? item?.displayName
      if (typeof displayName !== 'string' || !displayName.trim()) return null
      return { item, displayName: displayName.normalize('NFKC').trim(), resourceId: typeof item === 'string' ? displayName.trim() : item?.id ?? item?.resource_id ?? item?.resourceId ?? item?.slug ?? displayName.trim(), aliases: typeof item === 'string' ? [] : [item?.slug, item?.ref, item?.id, item?.resource_id, item?.resourceId].filter((value) => typeof value === 'string').map((value) => value.normalize('NFKC').trim()).filter(Boolean) }
    }).filter((item) => item && item.displayName)
    const matches = entries.filter((item) => normalizedMessage.includes(item.displayName)).sort((a, b) => b.displayName.length - a.displayName.length)
    if (!matches.length) {
      const aliasMentioned = entries.some((item) => item.aliases.some((alias) => alias !== item.displayName && alias.length >= 2 && normalizedMessage.includes(alias)))
      const partialMentioned = entries.some((item) => {
        const prefixLength = Math.max(2, Math.min(item.displayName.length - 1, 6))
        return item.displayName.length > prefixLength && normalizedMessage.includes(item.displayName.slice(0, prefixLength))
      })
      const recommendationMentioned = /(?:虾|shrimp)/iu.test(normalizedMessage) && /(?:推荐|搜索|查找|找一只|哪只|哪个)/iu.test(normalizedMessage)
      if (aliasMentioned || partialMentioned || recommendationMentioned) return { ok: false, matched: false, allowed: false, requested: true, code: 'SHRIMP_NOT_ALLOWED', reason: SUBSCRIBER_SHRIMP_RESPONSE }
      return { ok: false, matched: false, allowed: false, requested: false, code: null, reason: null }
    }
    const match = matches[0]
    const entitlement = this.store.get('SELECT * FROM entitlements WHERE subscriber_id = ? AND kind = ? AND status = ? AND (resource_id = ? OR display_name = ?)', subscriber.subscriber_id, 'shrimp', 'active', String(match.resourceId), match.displayName)
    if (!entitlement) return { ok: false, matched: false, allowed: false, requested: true, code: 'SHRIMP_NOT_ALLOWED', reason: SUBSCRIBER_SHRIMP_RESPONSE }
    return { ok: true, matched: true, allowed: true, requested: true, code: null, displayName: match.displayName, resourceId: match.resourceId, entitlementId: entitlement.entitlement_id }
  }

  /** Register the exact-name result for one short-lived shrimp invocation. */
  authorizeShrimpInvocation(input = {}) {
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    const subscriber = this._requireSubscriber(subscriberId)
    if (subscriber.status !== SUBSCRIBER_STATUSES.ACTIVE) throw new SubscriptionError('SUBSCRIBER_NOT_READY', '订阅者尚未激活')
    const sessionScope = text(input.sessionId ?? input.scopeKey ?? input.sessionScope, '虾调用会话范围', 300)
    const messageId = optionalText(input.messageId ?? input.turnId, 300)
    if (!messageId && !input.allowSessionScopedReceipt) throw new SubscriptionError('SHRIMP_RECEIPT_MESSAGE_REQUIRED', '虾调用授权必须绑定消息或 turn')
    const resourceId = text(input.resourceId ?? input.pipelineSlug ?? input.slug, '虾资源 ID', 500)
    const displayName = text(input.displayName ?? input.formalDisplayName, '虾正式名称', 500)
    const entitlement = this.store.get('SELECT * FROM entitlements WHERE subscriber_id = ? AND kind = ? AND resource_id = ? AND display_name = ? AND status = ?', subscriberId, 'shrimp', resourceId, displayName, 'active')
    if (!entitlement) throw new SubscriptionError('SHRIMP_NOT_ALLOWED', SUBSCRIBER_SHRIMP_RESPONSE)
    const ttlMs = Math.min(number(input.ttlMs ?? 10 * 60_000, '虾调用授权有效期', { min: 1_000, max: 10 * 60_000 }), 10 * 60_000)
    const maxUses = number(input.maxUses ?? input.batchSize ?? 1, '虾调用次数', { min: 1, max: 10 })
    const at = this._time()
    const receiptId = `shrimp_receipt_${randomUUID()}`
    const expiresAt = new Date(Date.parse(at) + ttlMs).toISOString()
    this.store.transaction(() => {
      this.store.run('INSERT INTO shrimp_invocation_receipts(receipt_id,subscriber_id,session_scope,message_id,resource_id,display_name,issued_at,expires_at,max_uses,uses,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', receiptId, subscriberId, sessionScope, messageId, resourceId, displayName, at, expiresAt, maxUses, 0, 'active', at, at)
      this._audit('shrimp.invocation.authorize', { subscriberId, details: { receiptId, sessionScope, messageId, resourceId, maxUses, expiresAt } })
    })
    return { ok: true, requested: true, receiptId, subscriberId, sessionScope, messageId, resourceId, displayName, expiresAt, maxUses, uses: 0 }
  }

  getShrimpInvocationReceipt(receiptId) { return mapShrimpReceipt(this.store.get('SELECT * FROM shrimp_invocation_receipts WHERE receipt_id = ?', id(receiptId, '虾调用授权 ID'))) }

  bindShrimpInvocation(input = {}) {
    const receiptId = id(input.receiptId ?? input.invocationReceiptId, '虾调用授权 ID')
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    const sessionScope = text(input.sessionId ?? input.scopeKey ?? input.sessionScope, '虾调用会话范围', 300)
    const row = this.store.get('SELECT * FROM shrimp_invocation_receipts WHERE receipt_id = ? AND subscriber_id = ? AND status = ?', receiptId, subscriberId, 'active')
    if (!row) return { allowed: false, code: 'SHRIMP_RECEIPT_INVALID', reason: SUBSCRIBER_SHRIMP_RESPONSE }
    const at = this._time()
    const changed = this.store.run('UPDATE shrimp_invocation_receipts SET session_scope = ?, updated_at = ? WHERE receipt_id = ? AND subscriber_id = ? AND status = ?', sessionScope, at, receiptId, subscriberId, 'active')
    if (!changed.changes) return { allowed: false, code: 'SHRIMP_RECEIPT_RACE', reason: SUBSCRIBER_SHRIMP_RESPONSE }
    this._audit('shrimp.invocation.bind', { subscriberId, details: { receiptId, sessionScope } })
    return { allowed: true, receipt: mapShrimpReceipt(this.store.get('SELECT * FROM shrimp_invocation_receipts WHERE receipt_id = ?', receiptId)) }
  }

  bindShrimpReceipt(input = {}) { return this.bindShrimpInvocation(input) }

  bindInvocationReceipt(input = {}) { return this.bindShrimpInvocation(input) }

  consumeShrimpInvocation(input = {}) {
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    const sessionScope = text(input.sessionId ?? input.scopeKey ?? input.sessionScope, '虾调用会话范围', 300)
    const resourceId = text(input.resourceId ?? input.pipelineSlug ?? input.slug, '虾资源 ID', 500)
    return this.store.transaction(() => {
      const suppliedReceiptId = input.receiptId ?? input.invocationReceiptId
      let row
      let receiptId = suppliedReceiptId ? id(suppliedReceiptId, '虾调用授权 ID') : null
      if (receiptId) row = this.store.get('SELECT * FROM shrimp_invocation_receipts WHERE receipt_id = ?', receiptId)
      else {
        const candidates = this.store.all('SELECT * FROM shrimp_invocation_receipts WHERE subscriber_id = ? AND session_scope = ? AND resource_id = ? AND status = ? ORDER BY issued_at DESC', subscriberId, sessionScope, resourceId, 'active')
        if (candidates.length !== 1) return { allowed: false, code: candidates.length > 1 ? 'SHRIMP_RECEIPT_AMBIGUOUS' : 'SHRIMP_RECEIPT_INVALID', reason: SUBSCRIBER_SHRIMP_RESPONSE }
        row = candidates[0]
        receiptId = row.receipt_id
      }
      if (!row || row.subscriber_id !== subscriberId || row.session_scope !== sessionScope || row.resource_id !== resourceId) return { allowed: false, code: 'SHRIMP_RECEIPT_INVALID', reason: SUBSCRIBER_SHRIMP_RESPONSE }
      if (input.messageId && row.message_id !== String(input.messageId)) return { allowed: false, code: 'SHRIMP_RECEIPT_INVALID', reason: SUBSCRIBER_SHRIMP_RESPONSE }
      const now = Date.parse(this._time())
      if (row.status !== 'active' || Date.parse(row.expires_at) <= now || Number(row.uses) >= Number(row.max_uses)) {
        if (row.status === 'active' && Date.parse(row.expires_at) <= now) this.store.run('UPDATE shrimp_invocation_receipts SET status = ?, updated_at = ? WHERE receipt_id = ?', 'expired', this._time(), receiptId)
        return { allowed: false, code: 'SHRIMP_RECEIPT_EXPIRED', reason: SUBSCRIBER_SHRIMP_RESPONSE }
      }
      const at = this._time()
      const nextUses = Number(row.uses) + 1
      const changed = this.store.run('UPDATE shrimp_invocation_receipts SET uses = ?, status = ?, updated_at = ? WHERE receipt_id = ? AND status = ? AND uses = ?', nextUses, nextUses >= Number(row.max_uses) ? 'consumed' : 'active', at, receiptId, 'active', Number(row.uses))
      if (!changed.changes) return { allowed: false, code: 'SHRIMP_RECEIPT_REPLAY', reason: SUBSCRIBER_SHRIMP_RESPONSE }
      this._audit('shrimp.invocation.consume', { subscriberId, details: { receiptId, resourceId, use: nextUses } })
      return { allowed: true, code: null, receiptId, subscriberId, sessionScope, resourceId, displayName: row.display_name, uses: nextUses, remainingUses: Math.max(0, Number(row.max_uses) - nextUses) }
    })
  }

  authorizeShrimpRun(input = {}) { return this.authorizeShrimpInvocation(input) }

  registerShrimpInvocation(input = {}) { return this.authorizeShrimpInvocation(input) }

  peekShrimpInvocation(input = {}) {
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    const sessionScope = text(input.sessionId ?? input.scopeKey ?? input.sessionScope, '虾调用会话范围', 300)
    const resourceId = text(input.resourceId ?? input.pipelineSlug ?? input.slug, '虾资源 ID', 500)
    const suppliedReceiptId = input.receiptId ?? input.invocationReceiptId
    let row = suppliedReceiptId ? this.store.get('SELECT * FROM shrimp_invocation_receipts WHERE receipt_id = ?', id(suppliedReceiptId, '虾调用授权 ID')) : null
    if (!row) {
      const candidates = this.store.all('SELECT * FROM shrimp_invocation_receipts WHERE subscriber_id = ? AND session_scope = ? AND resource_id = ? AND status = ? ORDER BY issued_at DESC', subscriberId, sessionScope, resourceId, 'active')
      if (candidates.length !== 1) return { allowed: false, code: candidates.length > 1 ? 'SHRIMP_RECEIPT_AMBIGUOUS' : 'SHRIMP_RECEIPT_INVALID', reason: SUBSCRIBER_SHRIMP_RESPONSE }
      row = candidates[0]
    }
    const valid = row.subscriber_id === subscriberId && row.session_scope === sessionScope && row.resource_id === resourceId && row.status === 'active' && Number(row.uses) < Number(row.max_uses) && Date.parse(row.expires_at) > Date.parse(this._time()) && (!input.messageId || row.message_id === String(input.messageId))
    return valid ? { allowed: true, code: null, receiptId: row.receipt_id, resourceId, displayName: row.display_name } : { allowed: false, code: 'SHRIMP_RECEIPT_INVALID', reason: SUBSCRIBER_SHRIMP_RESPONSE }
  }

  isAllowedWorkday(value) {
    const key = dateKey(value, this.timezone)
    const row = this.store.get('SELECT * FROM holiday_calendars WHERE year = ?', Number(key.slice(0, 4)))
    return isAllowedWorkdayFromCalendar(key, row ? mapCalendar(row) : null)
  }

  workdayStatus(value) {
    const key = dateKey(value, this.timezone)
    const row = this.store.get('SELECT * FROM holiday_calendars WHERE year = ?', Number(key.slice(0, 4)))
    return workdayInfo(key, row ? mapCalendar(row) : null)
  }

  upsertHolidayCalendar(input = {}, options = {}) {
    this._requireSystemActor(options)
    const normalized = normalizeHolidayCalendar(input)
    if (!normalized.sourceUrl) throw new SubscriptionError('HOLIDAY_SOURCE_REQUIRED', '节假日日历必须记录官方来源')
    const checksum = calendarChecksum(normalized)
    const at = this._time()
    this.store.transaction(() => {
      this.store.run(`INSERT INTO holiday_calendars(year,timezone,source_url,source_title,source_checksum,workdays_json,restdays_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(year) DO UPDATE SET timezone=excluded.timezone,source_url=excluded.source_url,source_title=excluded.source_title,source_checksum=excluded.source_checksum,workdays_json=excluded.workdays_json,restdays_json=excluded.restdays_json,updated_at=excluded.updated_at`, normalized.year, normalized.timezone, normalized.sourceUrl, normalized.sourceTitle, checksum, jsonText(normalized.workingDays), jsonText(normalized.restDays), at, at)
      this._audit('holiday.upsert', { details: { year: normalized.year, sourceChecksum: checksum } })
    })
    return mapCalendar(this.store.get('SELECT * FROM holiday_calendars WHERE year = ?', normalized.year))
  }

  getHolidayCalendar(year) {
    const value = number(year, '年份', { min: 2000, max: 2200 })
    return mapCalendar(this.store.get('SELECT * FROM holiday_calendars WHERE year = ?', value))
  }

  setHolidayCalendar(input = {}, options = {}) { return this.upsertHolidayCalendar(input, options) }

  _cycleFor(subscriberId, atValue = undefined, create = true) {
    const subscriber = this._requireSubscriber(subscriberId)
    const key = mondayOfWeek(atValue || this._time())
    let row = this.store.get('SELECT * FROM quota_cycles WHERE subscriber_id = ? AND period_key = ? ORDER BY generation DESC LIMIT 1', subscriberId, key)
    if (!row && create) {
      const cycleId = `cycle_${randomUUID()}`
      const at = this._time()
      this.store.run('INSERT INTO quota_cycles(cycle_id,subscriber_id,period_key,generation,period_start,period_end,limit_tokens,used_tokens,reserved_tokens,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', cycleId, subscriberId, key, 0, key, addDays(key, 6), Number(subscriber.weekly_token_limit || 0), 0, 0, 'active', at, at)
      row = this.store.get('SELECT * FROM quota_cycles WHERE cycle_id = ?', cycleId)
    }
    return row
  }

  ensureQuotaCycle(subscriberId, atValue = undefined) {
    return mapCycle(this.store.transaction(() => this._cycleFor(subscriberId, atValue, true)))
  }

  quotaStatus(subscriberId, options = {}) {
    if (subscriberId && typeof subscriberId === 'object') {
      options = subscriberId
      subscriberId = options.subscriberId
    }
    const row = this._requireSubscriber(subscriberId)
    const at = options.at || this._time()
    const cycle = this._cycleFor(subscriberId, at, true)
    const cycleValue = mapCycle(cycle)
    const day = this.workdayStatus(at)
    const policy = this.resolveRuntimePolicy(subscriberId)
    let reason = null
    if (!day.known) reason = 'HOLIDAY_CALENDAR_MISSING'
    else if (!day.allowed) reason = day.reason
    else if (row.status === SUBSCRIBER_STATUSES.SUSPENDED) reason = 'SUBSCRIBER_SUSPENDED'
    else if (row.status === SUBSCRIBER_STATUSES.REVOKED) reason = 'SUBSCRIBER_REVOKED'
    else if (row.status !== SUBSCRIBER_STATUSES.ACTIVE) reason = 'SUBSCRIBER_NOT_READY'
    else if (!policy.workspaceRoot) reason = 'WORKSPACE_REQUIRED'
    else if (cycleValue.limitTokens <= cycleValue.usedTokens + cycleValue.reservedTokens) reason = 'QUOTA_EXHAUSTED'
    return {
      allowed: reason === null,
      reason,
      workday: day,
      cycle: cycleValue,
      usedTokens: cycleValue.usedTokens,
      reservedTokens: cycleValue.reservedTokens,
      remainingTokens: cycleValue.remainingTokens,
      nextCycleStart: `${nextWeekStart(at)}T00:00:00+08:00`,
      subscriberId,
    }
  }

  reserveQuota(subscriberId, amountOrOptions, maybeOptions = {}) {
    if (subscriberId && typeof subscriberId === 'object') {
      const input = subscriberId
      subscriberId = input.subscriberId
      amountOrOptions = { ...input, ...(typeof amountOrOptions === 'object' ? amountOrOptions : {}) }
    }
    const options = typeof amountOrOptions === 'object' ? amountOrOptions : { ...maybeOptions, amountTokens: amountOrOptions }
    const amount = number(options.amountTokens ?? options.amount ?? options.tokens, '预留 Token 数', { min: 1, max: Number.MAX_SAFE_INTEGER })
    const at = options.at || this._time()
    const idempotencyKey = optionalText(options.idempotencyKey ?? options.requestId, 300)
    try {
      const result = this.store.transaction(() => {
        const status = this.quotaStatus(subscriberId, { at })
        if (!status.allowed && status.reason !== 'QUOTA_EXHAUSTED') throw new SubscriptionError(status.reason, status.reason === 'HOLIDAY_CALENDAR_MISSING' ? '缺少该年份的国务院节假日日历，已拒绝使用' : '当前不允许使用订阅额度')
        const existing = idempotencyKey ? this.store.get('SELECT * FROM quota_reservations WHERE subscriber_id = ? AND idempotency_key = ?', subscriberId, idempotencyKey) : null
        if (existing) return { reservation: mapReservation(existing), idempotent: true }
        const cycle = this._cycleFor(subscriberId, at, true)
        const remaining = Number(cycle.limit_tokens || 0) - Number(cycle.used_tokens || 0) - Number(cycle.reserved_tokens || 0)
        if (amount > remaining) throw new SubscriptionError('QUOTA_EXHAUSTED', '本周 Token 额度不足')
        const reservationId = `res_${randomUUID()}`
        const timestamp = this._time()
        this.store.run('INSERT INTO quota_reservations(reservation_id,cycle_id,subscriber_id,amount_tokens,state,idempotency_key,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', reservationId, cycle.cycle_id, subscriberId, amount, QUOTA_STATES.RESERVED, idempotencyKey, jsonText(sanitizeMetadata(options.metadata)), timestamp, timestamp)
        this.store.run('UPDATE quota_cycles SET reserved_tokens = reserved_tokens + ?, updated_at = ? WHERE cycle_id = ?', amount, timestamp, cycle.cycle_id)
        this._audit('quota.reserve', { subscriberId, details: { reservationId, amountTokens: amount, cycleId: cycle.cycle_id } })
        return { reservation: mapReservation(this.store.get('SELECT * FROM quota_reservations WHERE reservation_id = ?', reservationId)), idempotent: false }
      })
      return { ok: true, ...result }
    } catch (error) {
      if (error instanceof SubscriptionError) { try { this._audit('quota.reserve', { subscriberId, outcome: 'denied', details: { code: error.code } }) } catch {} }
      throw error
    }
  }

  reserve(subscriberId, amountOrOptions, maybeOptions) { return this.reserveQuota(subscriberId, amountOrOptions, maybeOptions) }

  /**
   * Turn-scoped quota lease.  A lease reserves the subscriber's entire
   * currently available balance once, then each model/tool step records its
   * actual usage against that same reservation.  This prevents a multi-step
   * turn from bypassing the hard quota by issuing several small reservations.
   */
  beginQuotaLease(subscriberId, options = {}) {
    if (subscriberId && typeof subscriberId === 'object') {
      options = subscriberId
      subscriberId = options.subscriberId
    }
    const at = options.at || this._time()
    const idempotencyKey = optionalText(options.requestId ?? options.idempotencyKey, 300)
    if (!idempotencyKey) throw new SubscriptionError('REQUEST_ID_REQUIRED', '额度 lease 必须提供 requestId')
    return this.store.transaction(() => {
      const status = this.quotaStatus(subscriberId, { at })
      if (!status.allowed) throw new SubscriptionError(status.reason, status.reason === 'HOLIDAY_CALENDAR_MISSING' ? '缺少该年份的国务院节假日日历，已拒绝使用' : '当前不允许开启额度 lease')
      const existing = this.store.get('SELECT * FROM quota_reservations WHERE subscriber_id = ? AND idempotency_key = ?', subscriberId, idempotencyKey)
      if (existing) return { ok: true, lease: mapReservation(existing), reservation: mapReservation(existing), idempotent: true }
      const cycle = this._cycleFor(subscriberId, at, true)
      const remaining = Number(cycle.limit_tokens || 0) - Number(cycle.used_tokens || 0) - Number(cycle.reserved_tokens || 0)
      if (remaining <= 0) throw new SubscriptionError('QUOTA_EXHAUSTED', '本周 Token 额度不足')
      const reservationId = `lease_${randomUUID()}`
      const timestamp = this._time()
      this.store.run('INSERT INTO quota_reservations(reservation_id,cycle_id,subscriber_id,amount_tokens,actual_tokens,state,idempotency_key,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', reservationId, cycle.cycle_id, subscriberId, remaining, 0, QUOTA_STATES.RESERVED, idempotencyKey, jsonText({ ...sanitizeMetadata(options.metadata), lease: true }), timestamp, timestamp)
      this.store.run('UPDATE quota_cycles SET reserved_tokens = reserved_tokens + ?, updated_at = ? WHERE cycle_id = ?', remaining, timestamp, cycle.cycle_id)
      this._audit('quota.lease.begin', { subscriberId, details: { reservationId, amountTokens: remaining, cycleId: cycle.cycle_id, requestId: idempotencyKey } })
      const reservation = mapReservation(this.store.get('SELECT * FROM quota_reservations WHERE reservation_id = ?', reservationId))
      return { ok: true, lease: reservation, reservation, idempotent: false }
    })
  }

  recordQuotaUsage(reservationId, deltaTokens, options = {}) {
    if (reservationId && typeof reservationId === 'object') {
      const input = reservationId
      reservationId = input.reservationId ?? input.leaseId
      deltaTokens = input.deltaTokens ?? input.tokens ?? input.amountTokens
      options = input
    }
    const rid = id(reservationId, '额度 lease ID')
    const delta = number(deltaTokens, '本次 Token 用量', { min: 0, max: Number.MAX_SAFE_INTEGER })
    if (delta === 0) return { ok: true, lease: mapReservation(this.store.get('SELECT * FROM quota_reservations WHERE reservation_id = ?', rid)), idempotent: true }
    return this.store.transaction(() => {
      const row = this.store.get('SELECT * FROM quota_reservations WHERE reservation_id = ?', rid)
      if (!row) throw new SubscriptionError('RESERVATION_NOT_FOUND', '额度 lease 不存在')
      if (row.state !== QUOTA_STATES.RESERVED) throw new SubscriptionError('RESERVATION_NOT_ACTIVE', '额度 lease 已结束')
      const previous = Number(row.actual_tokens || 0)
      const remainingLease = Number(row.amount_tokens || 0) - previous
      if (delta > remainingLease) throw new SubscriptionError('QUOTA_LEASE_EXHAUSTED', '本轮 Token lease 额度不足')
      const at = this._time()
      const changed = this.store.run('UPDATE quota_reservations SET actual_tokens = COALESCE(actual_tokens, 0) + ?, updated_at = ? WHERE reservation_id = ? AND state = ? AND COALESCE(actual_tokens, 0) + ? <= amount_tokens', delta, at, rid, QUOTA_STATES.RESERVED, delta)
      if (!changed.changes) throw new SubscriptionError('RESERVATION_RACE', '额度 lease 已被其他请求处理')
      this.store.run('UPDATE quota_cycles SET reserved_tokens = MAX(0, reserved_tokens - ?), used_tokens = used_tokens + ?, updated_at = ? WHERE cycle_id = ?', delta, delta, at, row.cycle_id)
      this._audit('quota.lease.usage', { subscriberId: row.subscriber_id, details: { reservationId: rid, deltaTokens: delta } })
      const lease = mapReservation(this.store.get('SELECT * FROM quota_reservations WHERE reservation_id = ?', rid))
      return { ok: true, lease, reservation: lease, idempotent: false }
    })
  }

  finalizeQuotaLease(reservationId, options = {}) {
    if (reservationId && typeof reservationId === 'object') {
      options = reservationId
      reservationId = options.reservationId ?? options.leaseId
    }
    const rid = id(reservationId, '额度 lease ID')
    return this.store.transaction(() => {
      const row = this.store.get('SELECT * FROM quota_reservations WHERE reservation_id = ?', rid)
      if (!row) throw new SubscriptionError('RESERVATION_NOT_FOUND', '额度 lease 不存在')
      if (row.state === QUOTA_STATES.SETTLED) return { ok: true, lease: mapReservation(row), reservation: mapReservation(row), idempotent: true }
      if (row.state !== QUOTA_STATES.RESERVED) throw new SubscriptionError('RESERVATION_NOT_ACTIVE', '额度 lease 已释放')
      const used = Number(row.actual_tokens || 0)
      const remaining = Math.max(0, Number(row.amount_tokens || 0) - used)
      const at = this._time()
      const changed = this.store.run('UPDATE quota_reservations SET state = ?, updated_at = ? WHERE reservation_id = ? AND state = ?', QUOTA_STATES.SETTLED, at, rid, QUOTA_STATES.RESERVED)
      if (!changed.changes) throw new SubscriptionError('RESERVATION_RACE', '额度 lease 已被其他请求处理')
      if (remaining) this.store.run('UPDATE quota_cycles SET reserved_tokens = MAX(0, reserved_tokens - ?), updated_at = ? WHERE cycle_id = ?', remaining, at, row.cycle_id)
      this._audit('quota.lease.finalize', { subscriberId: row.subscriber_id, details: { reservationId: rid, actualTokens: used, releasedTokens: remaining } })
      const lease = mapReservation(this.store.get('SELECT * FROM quota_reservations WHERE reservation_id = ?', rid))
      return { ok: true, lease, reservation: lease, idempotent: false }
    })
  }

  settleQuota(reservationId, actualTokens, options = {}) {
    if (reservationId && typeof reservationId === 'object') {
      const input = reservationId
      reservationId = input.reservationId
      actualTokens = input.actualTokens ?? input.tokens
      options = input
    }
    const rid = id(reservationId, '预留 ID')
    const actual = number(actualTokens ?? options.actualTokens ?? options.tokens, '实际 Token 数', { min: 0, max: Number.MAX_SAFE_INTEGER })
    return this.store.transaction(() => {
      const row = this.store.get('SELECT * FROM quota_reservations WHERE reservation_id = ?', rid)
      if (!row) throw new SubscriptionError('RESERVATION_NOT_FOUND', '额度预留不存在')
      if (row.state === QUOTA_STATES.SETTLED) return { ok: true, reservation: mapReservation(row), idempotent: true }
      if (row.state !== QUOTA_STATES.RESERVED) throw new SubscriptionError('RESERVATION_NOT_ACTIVE', '额度预留已释放')
      const at = this._time()
      const result = this.store.run('UPDATE quota_reservations SET state = ?, actual_tokens = ?, updated_at = ? WHERE reservation_id = ? AND state = ?', QUOTA_STATES.SETTLED, actual, at, rid, QUOTA_STATES.RESERVED)
      if (!result.changes) throw new SubscriptionError('RESERVATION_RACE', '额度预留已被其他请求结算')
      this.store.run('UPDATE quota_cycles SET reserved_tokens = MAX(0, reserved_tokens - ?), used_tokens = used_tokens + ?, updated_at = ? WHERE cycle_id = ?', Number(row.amount_tokens), actual, at, row.cycle_id)
      this._audit('quota.settle', { subscriberId: row.subscriber_id, details: { reservationId: rid, actualTokens: actual } })
      return { ok: true, reservation: mapReservation(this.store.get('SELECT * FROM quota_reservations WHERE reservation_id = ?', rid)), idempotent: false }
    })
  }

  settle(reservationId, actualTokens, options) { return this.settleQuota(reservationId, actualTokens, options) }

  releaseQuota(reservationId, options = {}) {
    if (reservationId && typeof reservationId === 'object') {
      options = reservationId
      reservationId = options.reservationId
    }
    const rid = id(reservationId, '预留 ID')
    return this.store.transaction(() => {
      const row = this.store.get('SELECT * FROM quota_reservations WHERE reservation_id = ?', rid)
      if (!row) throw new SubscriptionError('RESERVATION_NOT_FOUND', '额度预留不存在')
      if (row.state === QUOTA_STATES.RELEASED) return { ok: true, reservation: mapReservation(row), idempotent: true }
      if (row.state === QUOTA_STATES.SETTLED) throw new SubscriptionError('RESERVATION_ALREADY_SETTLED', '已结算的额度不能释放')
      const at = this._time()
      const result = this.store.run('UPDATE quota_reservations SET state = ?, updated_at = ? WHERE reservation_id = ? AND state = ?', QUOTA_STATES.RELEASED, at, rid, QUOTA_STATES.RESERVED)
      if (!result.changes) throw new SubscriptionError('RESERVATION_RACE', '额度预留已被其他请求处理')
      this.store.run('UPDATE quota_cycles SET reserved_tokens = MAX(0, reserved_tokens - ?), updated_at = ? WHERE cycle_id = ?', Number(row.amount_tokens), at, row.cycle_id)
      this._audit('quota.release', { subscriberId: row.subscriber_id, details: { reservationId: rid } })
      return { ok: true, reservation: mapReservation(this.store.get('SELECT * FROM quota_reservations WHERE reservation_id = ?', rid)), idempotent: false }
    })
  }

  release(reservationId, options) { return this.releaseQuota(reservationId, options) }

  resetQuota(subscriberId, options = {}) {
    if (subscriberId && typeof subscriberId === 'object') {
      options = subscriberId
      subscriberId = options.subscriberId
    }
    this._requireSystemActor(options)
    const subscriber = this._requireSubscriber(subscriberId)
    const atValue = options.at || this._time()
    const key = mondayOfWeek(atValue)
    return this.store.transaction(() => {
      const current = this._cycleFor(subscriberId, atValue, true)
      const generation = Number(current.generation || 0) + 1
      const at = this._time()
      const released = this.store.run('UPDATE quota_reservations SET state = ?, updated_at = ? WHERE subscriber_id = ? AND state = ?', QUOTA_STATES.RELEASED, at, subscriberId, QUOTA_STATES.RESERVED)
      this.store.run('UPDATE quota_cycles SET reserved_tokens = 0, updated_at = ? WHERE subscriber_id = ? AND reserved_tokens != 0', at, subscriberId)
      this.store.run('UPDATE quota_cycles SET status = ?, updated_at = ? WHERE cycle_id = ?', 'reset', at, current.cycle_id)
      const cycleId = `cycle_${randomUUID()}`
      this.store.run('INSERT INTO quota_cycles(cycle_id,subscriber_id,period_key,generation,period_start,period_end,limit_tokens,used_tokens,reserved_tokens,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', cycleId, subscriberId, key, generation, key, addDays(key, 6), Number(subscriber.weekly_token_limit || 0), 0, 0, 'active', at, at)
      this._audit('quota.reset', { subscriberId, details: { previousCycleId: current.cycle_id, cycleId, generation, releasedReservations: Number(released.changes || 0) } })
      return mapCycle(this.store.get('SELECT * FROM quota_cycles WHERE cycle_id = ?', cycleId))
    })
  }

  reset(subscriberId, options) { return this.resetQuota(subscriberId, options) }

  isModelUsageMetered(subscriberId, model) {
    const parsed = parseModel(model)
    const row = this.store.get('SELECT metadata_json FROM entitlements WHERE subscriber_id = ? AND kind = ? AND resource_id = ? AND status = ?', id(subscriberId, '订阅者 ID'), 'model', parsed.resourceId, 'active')
    return Boolean(row && usageMeteredFlag(parseJson(row.metadata_json, {})))
  }

  authorizeModelCall(input = {}) {
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    if (input.actorRole && input.actorRole !== ROLE_SUBSCRIBER) return { allowed: true, usageRequired: false }
    let metered = false
    try { metered = this.isModelUsageMetered(subscriberId, input.model || `${input.provider}/${input.modelId}`) } catch { metered = false }
    if (!metered) {
      try { this._audit('quota.usage-missing', { subscriberId, outcome: 'denied', details: { code: 'MODEL_USAGE_UNMETERED' } }) } catch {}
      return { allowed: false, code: 'MODEL_USAGE_UNMETERED', reason: '该模型没有可靠 usage 计量，不能用于订阅会话。' }
    }
    const tokens = usageFromValue(input.usage)
    if (tokens === null) {
      try { this._audit('quota.usage-missing', { subscriberId, outcome: 'denied', details: { code: 'USAGE_REQUIRED' } }) } catch {}
      return { allowed: false, code: 'USAGE_REQUIRED', reason: '订阅模型调用必须返回可核验的 Token usage。' }
    }
    return { allowed: true, code: null, usageRequired: true, tokens }
  }

  recordSubscriberUsage(input = {}) {
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    const gate = this.authorizeModelCall({ ...input, actorRole: ROLE_SUBSCRIBER })
    if (!gate.allowed) throw new SubscriptionError(gate.code, gate.reason)
    const reservationId = input.reservationId || input.leaseId
    if (!reservationId) throw new SubscriptionError('RESERVATION_REQUIRED', '订阅模型 usage 必须绑定 quota reservation')
    return this.recordQuotaUsage(reservationId, gate.tokens, input)
  }

  recordModelUsage(input = {}) { return this.recordSubscriberUsage(input) }

  registerSession(input = {}, options = {}) {
    const sessionId = id(input.sessionId ?? input.id, '会话 ID')
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    const accountId = id(input.accountId, '机器人账户 ID')
    const subscriber = this._requireSubscriber(subscriberId)
    const account = this.store.get('SELECT * FROM robot_accounts WHERE account_id = ? AND subscriber_id = ?', accountId, subscriberId)
    if (!account) throw new SubscriptionError('SESSION_ACCOUNT_MISMATCH', '会话机器人不属于该订阅者')
    const current = this.store.get('SELECT * FROM session_lineage WHERE session_id = ?', sessionId)
    if (current && (current.subscriber_id !== subscriberId || current.account_id !== accountId)) throw new SubscriptionError('SESSION_TENANT_MISMATCH', '会话不能跨订阅者复用')
    this._checkExpectedRevision(current || { revision: 1 }, options.expectedRevision ?? input.expectedRevision, '会话')
    const at = this._time()
    const agentId = optionalText(input.agentId, 300)
    const parentSessionId = input.parentSessionId ? id(input.parentSessionId, '父会话 ID') : null
    const kind = optionalText(input.kind, 80) || 'main'
    const status = optionalText(input.status, 80) || 'active'
    this.store.transaction(() => {
      if (current) {
        const result = this.store.run('UPDATE session_lineage SET agent_id = ?, parent_session_id = ?, kind = ?, status = ?, metadata_json = ?, revision = revision + 1, updated_at = ? WHERE session_id = ? AND revision = ?', agentId, parentSessionId, kind, status, jsonText(sanitizeMetadata(input.metadata)), at, sessionId, Number(current.revision))
        if (!result.changes) throw new SubscriptionError('CAS_CONFLICT', '会话已变化，请重新读取后提交', undefined, 409)
      } else this.store.run('INSERT INTO session_lineage(session_id,subscriber_id,account_id,agent_id,parent_session_id,kind,status,metadata_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', sessionId, subscriberId, accountId, agentId, parentSessionId, kind, status, jsonText(sanitizeMetadata(input.metadata)), 1, at, at)
      this._audit('session.register', { subscriberId, details: { sessionId, accountId, kind } })
    })
    return mapLineage(this.store.get('SELECT * FROM session_lineage WHERE session_id = ?', sessionId))
  }

  async registerSubscriberSession(input = {}, options = {}) {
    const lineage = this.registerSession(input, options)
    const policy = this.resolveRuntimePolicy(input.subscriberId)
    if (!policy.hostWorkspaceId) throw new SubscriptionError('HOST_WORKSPACE_REQUIRED', '订阅工作区必须来自大神主工作区')
    let registry = this.workspaceRegistry
    try { registry = registry || this.workspaceRegistryResolver?.() } catch { registry = null }
    const workspace = typeof registry?.get === 'function' ? registry.get(policy.hostWorkspaceId) : registry?.list?.().find((item) => String(item?.id ?? item?.workspaceId ?? '') === policy.hostWorkspaceId)
    if (!workspace || typeof workspace.attachSession !== 'function') throw new SubscriptionError('HOST_WORKSPACE_NOT_FOUND', '当前大神工作区不存在或无法加入会话')
    await workspace.attachSession(input.sessionId)
    return { ...lineage, hostWorkspaceId: policy.hostWorkspaceId, workspaceRoot: policy.workspaceRoot }
  }

  resolveSubscriberForSession(sessionId) {
    if (!sessionId) return null
    return this.store.get('SELECT subscriber_id FROM session_lineage WHERE session_id = ?', String(sessionId))?.subscriber_id || null
  }

  resolveSubscriberForAgent(agentId) {
    if (!agentId) return null
    return this.store.get('SELECT subscriber_id FROM session_lineage WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 1', String(agentId))?.subscriber_id || null
  }

  resolveSubscriberForAgentOrSession({ agentId, sessionId } = {}) { return this.resolveSubscriberForAgent(agentId) || this.resolveSubscriberForSession(sessionId) }

  createSubscriberAssertion(input = {}) {
    const subscriberId = id(input.subscriberId, '订阅者 ID')
    const accountId = id(input.accountId, '机器人账户 ID')
    const subscriber = this._requireSubscriber(subscriberId)
    const account = this.store.get('SELECT account_id FROM robot_accounts WHERE account_id = ? AND subscriber_id = ?', accountId, subscriberId)
    if (!account) throw new SubscriptionError('ASSERTION_ACCOUNT_MISMATCH', '断言机器人不属于该订阅者')
    if (subscriber.status !== SUBSCRIBER_STATUSES.ACTIVE) throw new SubscriptionError('SUBSCRIBER_NOT_READY', '订阅者尚未激活')
    const subscriberMetadata = rowMetadata(subscriber)
    const explicitShrimpAccountId = input.shrimptankAccountId ?? input.shrimpTankAccountId
    const explicitShrimpUserId = input.shrimptankUserId ?? input.shrimpTankUserId
    const shrimptankAccountId = text(explicitShrimpAccountId ?? subscriberMetadata.shrimptankAccountId ?? subscriberMetadata.shrimptank_account_id ?? subscriberMetadata.account_id, 'ShrimpTank account_id', 300)
    const shrimptankUserId = text(explicitShrimpUserId ?? subscriberMetadata.shrimptankUserId ?? subscriberMetadata.shrimptank_user_id ?? subscriberMetadata.user_id, 'ShrimpTank user_id', 300)
    const issuedInput = input.issuedAt
    const issuedAtMs = typeof issuedInput === 'number' && Number.isFinite(issuedInput)
      ? (issuedInput < 10_000_000_000 ? issuedInput * 1_000 : issuedInput)
      : Date.parse(issuedInput || this._time())
    if (!Number.isFinite(issuedAtMs)) throw new SubscriptionError('INVALID_TIME', '断言签发时间无效')
    const issuedAt = Math.floor(issuedAtMs / 1_000)
    const ttlMs = Math.min(number(input.ttlMs ?? DEFAULT_ASSERTION_TTL_MS, '断言有效期', { min: 1_000, max: MAX_ASSERTION_TTL_MS }), MAX_ASSERTION_TTL_MS)
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1_000))
    const nonce = input.nonce ? text(input.nonce, '断言 nonce', 200) : randomBytes(16).toString('base64url')
    const claims = {
      subscriberId,
      accountId: shrimptankAccountId,
      userId: shrimptankUserId,
      robotAccountId: accountId,
      identitySource: explicitShrimpAccountId && explicitShrimpUserId ? 'explicit' : 'metadata',
      issuedAt,
      expiresAt: issuedAt + ttlSeconds,
      nonce,
      ...(input.quotaLimitTokens === undefined ? {} : { quotaLimitTokens: number(input.quotaLimitTokens, 'quotaLimitTokens', { min: 0, max: Number.MAX_SAFE_INTEGER }) }),
      scopes: [...new Set((Array.isArray(input.scopes) ? input.scopes : SUBSCRIBER_SAFE_SCOPES).map((item) => text(item, '断言 scope', 120)))].slice(0, 32),
    }
    if (claims.scopes.some((scope) => !SUBSCRIBER_SAFE_SCOPES.includes(scope))) throw new SubscriptionError('ASSERTION_SCOPE_FORBIDDEN', '断言 scope 不在订阅者允许范围内')
    const { encoded, signature } = signSubscriberAssertionClaims(claims, this.hmacSecret)
    return { claims, assertion: encoded, signature, headers: { [SUBSCRIBER_ASSERTION_HEADER]: encoded, [SUBSCRIBER_SIGNATURE_HEADER]: signature } }
  }

  createSubscriberAssertionHeaders(input = {}) { return this.createSubscriberAssertion(input).headers }

  createSubscriberAssertionForSession(input = {}) {
    const sessionId = id(input.sessionId, '会话 ID')
    const lineage = this.store.get('SELECT * FROM session_lineage WHERE session_id = ? AND status != ?', sessionId, 'revoked')
    if (!lineage) throw new SubscriptionError('SESSION_NOT_FOUND', '会话 lineage 不存在')
    const leases = this.store.all('SELECT * FROM quota_reservations WHERE subscriber_id = ? AND state = ? ORDER BY created_at ASC', lineage.subscriber_id, QUOTA_STATES.RESERVED)
    if (leases.length !== 1) throw new SubscriptionError('QUOTA_LEASE_REQUIRED', '会话断言需要且只能绑定一个活动 quota lease')
    const lease = leases[0]
    const quotaLimitTokens = Math.max(0, Number(lease.amount_tokens || 0) - Number(lease.actual_tokens || 0))
    return this.createSubscriberAssertion({ subscriberId: lineage.subscriber_id, accountId: lineage.account_id, scopes: input.scopes, ttlMs: input.ttlMs, issuedAt: input.issuedAt, nonce: input.nonce, quotaLimitTokens })
  }

  verifySubscriberAssertion(assertion, signature, options = {}) {
    let claims
    try { claims = JSON.parse(fromBase64url(assertion).toString('utf8')) } catch { return { valid: false, code: 'ASSERTION_INVALID' } }
    const expected = createHmac('sha256', this.hmacSecret).update(String(assertion), 'utf8').digest('hex')
    if (!constantTimeHexEqual(expected, String(signature || ''))) return { valid: false, code: 'ASSERTION_SIGNATURE_INVALID' }
    const nowInput = options.now || this._time()
    const nowMs = typeof nowInput === 'number' && Number.isFinite(nowInput) ? (nowInput < 10_000_000_000 ? nowInput * 1_000 : nowInput) : Date.parse(nowInput)
    const now = Math.floor(nowMs / 1_000)
    const issued = Number(claims?.issuedAt)
    const expires = Number(claims?.expiresAt)
    if (!claims || !ID_RE.test(String(claims.subscriberId || '')) || !String(claims.accountId || '').trim() || !String(claims.userId || '').trim() || !ID_RE.test(String(claims.robotAccountId || '')) || (claims.quotaLimitTokens !== undefined && (!Number.isInteger(Number(claims.quotaLimitTokens)) || Number(claims.quotaLimitTokens) < 0)) || !Number.isInteger(issued) || !Number.isInteger(expires) || expires <= issued || expires <= now || issued > now + 60) return { valid: false, code: 'ASSERTION_EXPIRED' }
    const subscriber = this.store.get('SELECT * FROM subscribers WHERE subscriber_id = ?', claims.subscriberId)
    const account = this.store.get('SELECT * FROM robot_accounts WHERE account_id = ? AND subscriber_id = ?', claims.robotAccountId, claims.subscriberId)
    if (!subscriber || !account || subscriber.status !== SUBSCRIBER_STATUSES.ACTIVE || account.status !== 'active') return { valid: false, code: 'ASSERTION_SUBSCRIBER_INACTIVE' }
    const metadata = rowMetadata(subscriber)
    const metadataAccountId = metadata.shrimptankAccountId ?? metadata.shrimptank_account_id ?? metadata.account_id
    const metadataUserId = metadata.shrimptankUserId ?? metadata.shrimptank_user_id ?? metadata.user_id
    if (claims.identitySource !== 'explicit' && (metadataAccountId !== claims.accountId || metadataUserId !== claims.userId)) return { valid: false, code: 'ASSERTION_SHRIMPTANK_ID_MISMATCH' }
    return { valid: true, claims }
  }

  enqueueOutbox(input = {}, options = {}) {
    this._requireSystemActor(options)
    const kind = text(input.kind, 'outbox 类型', 200)
    const key = text(input.idempotencyKey, '幂等键', 300)
    const at = this._time()
    this.store.run('INSERT OR IGNORE INTO outbox(outbox_id,kind,aggregate_id,idempotency_key,payload_json,status,attempts,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', input.outboxId ? id(input.outboxId, 'outbox ID') : `out_${randomUUID()}`, kind, optionalText(input.aggregateId, 300), key, jsonText(sanitizeMetadata(input.payload)), 'pending', 0, optionalText(input.nextAttemptAt, 80), at, at)
    return mapOutbox(this.store.get('SELECT * FROM outbox WHERE idempotency_key = ?', key))
  }

  listOutbox(options = {}) { return this.store.all('SELECT * FROM outbox ORDER BY created_at ASC LIMIT ?', number(options.limit ?? 100, 'outbox limit', { min: 1, max: 1_000 })).map(mapOutbox) }

  markOutbox(outboxId, status, options = {}) {
    this._requireSystemActor(options)
    const allowed = new Set(['pending', 'processing', 'completed', 'failed'])
    if (!allowed.has(status)) throw new SubscriptionError('OUTBOX_STATUS_INVALID', 'outbox 状态无效')
    const at = this._time()
    const result = this.store.run('UPDATE outbox SET status = ?, attempts = attempts + ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE outbox_id = ?', status, status === 'failed' ? 1 : 0, optionalText(options.error, 2_000), optionalText(options.nextAttemptAt, 80), at, id(outboxId, 'outbox ID'))
    if (!result.changes) throw new SubscriptionError('OUTBOX_NOT_FOUND', 'outbox 记录不存在')
    return mapOutbox(this.store.get('SELECT * FROM outbox WHERE outbox_id = ?', outboxId))
  }

  auditEvents(options = {}) {
    const params = []
    let sql = 'SELECT * FROM audit_events'
    if (options.subscriberId) { sql += ' WHERE subscriber_id = ?'; params.push(id(options.subscriberId, '订阅者 ID')) }
    sql += ' ORDER BY audit_id DESC LIMIT ?'; params.push(number(options.limit ?? 100, '审计 limit', { min: 1, max: 1_000 }))
    return this.store.all(sql, ...params).map(mapAudit)
  }

  adminStatus() {
    const subscribers = this.store.get('SELECT COUNT(*) AS count FROM subscribers')
    const active = this.store.get('SELECT COUNT(*) AS count FROM subscribers WHERE status = ?', SUBSCRIBER_STATUSES.ACTIVE)
    const robots = this.store.get('SELECT COUNT(*) AS count FROM robot_accounts WHERE status = ?', 'active')
    return { ok: true, subscribers: Number(subscribers?.count || 0), activeSubscribers: Number(active?.count || 0), activeRobots: Number(robots?.count || 0), db: { backend: 'sqlite', journalMode: this.store.pragma('journal_mode')?.journal_mode || 'wal' }, nativeAdmin: { required: true } }
  }

  _actionPayload(body) {
    const payload = body?.payload && typeof body.payload === 'object' ? body.payload : body || {}
    return { action: String(body?.action || payload.action || '').trim(), payload }
  }

  async dispatchAdmin(body = {}) {
    const { action, payload } = this._actionPayload(body)
    if (!action) throw new SubscriptionError('ADMIN_ACTION_REQUIRED', '缺少管理 action', undefined, 400)
    const options = { expectedRevision: body.expectedRevision ?? payload.expectedRevision, actorRole: ROLE_SYSTEM_OWNER, actorId: body.actorId }
    switch (action) {
      case 'subscriber.list': case 'listSubscribers': return this.listSubscribers()
      case 'subscriber.status': case 'subscriberStatus': return this.subscriberStatus(payload)
      case 'subscriber.create': case 'createSubscriber': return this.createSubscriber(payload, options)
      case 'subscriber.update': case 'updateSubscriber': return this.updateSubscriber(payload.subscriberId, payload, options)
      case 'subscriber.suspend': case 'suspendSubscriber': return this.suspendSubscriber(payload.subscriberId, options)
      case 'subscriber.resume': case 'resumeSubscriber': return this.resumeSubscriber(payload.subscriberId, options)
      case 'subscriber.revoke': case 'revokeSubscriber': return this.revokeSubscriber(payload.subscriberId, options)
      case 'robot.register': case 'registration.register': case 'registration.create': case 'registerRobotAccount': return this.registerRobotAccount(payload, options)
      case 'robot.list': case 'listRobotAccounts': return this.listRobotAccounts(payload.subscriberId)
      case 'robot.brand': case 'registration.brand': case 'verifyRobotBrand': return this.updateRobotBrand(payload.accountId, payload, options)
      case 'registration.begin': return this.beginRegistration(payload, options)
      case 'registration.status': return this.registrationStatus(payload, options)
      case 'registration.wait': case 'registration.credentials': return this.waitForRegistrationCredentials(payload, options)
      case 'registration.cancel': return this.cancelRegistration(payload, options)
      case 'workspace.create': case 'createWorkspace': return this.createWorkspace(payload, options)
      case 'workspace.host-create': case 'createHostWorkspace': return this.createHostWorkspace(payload, options)
      case 'workspace.list': case 'listWorkspaces': return this.listWorkspaces(payload.subscriberId)
      case 'workspace.share': case 'shareHostWorkspace': return this.shareHostWorkspace(payload, options)
      case 'workspace.grant': case 'grantWorkspace': return this.grantWorkspace(payload.subscriberId, payload.workspaceId, options)
      case 'workspace.revoke': case 'revokeWorkspace': return this.revokeWorkspace(payload.subscriberId, payload.workspaceId, options)
      case 'entitlement.grant': case 'grantEntitlement': return this.grantEntitlement(payload, options)
      case 'entitlement.revoke': case 'revokeEntitlement': return this.revokeEntitlement(payload, options)
      case 'entitlement.list': case 'listEntitlements': return this.listEntitlements(payload.subscriberId)
      case 'selection.set': case 'setSelections': return this.setSelections(payload.subscriberId, payload, options)
      case 'selection.list': case 'listSelections': return this.listSelections(payload.subscriberId)
      case 'binding.begin': case 'beginBindingChallenge': return this.beginBindingChallenge(payload.subscriberId, payload, options)
      case 'binding.complete': case 'completeBindingChallenge': return this.completeBindingChallenge(payload, options)
      case 'binding.consume': case 'consumeBindingChallenge': return this.consumeBindingChallenge(payload, options)
      case 'quota.status': case 'quotaStatus': return this.quotaStatus(payload.subscriberId, payload)
      case 'quota.reset': case 'resetQuota': return this.resetQuota(payload.subscriberId, options)
      case 'catalog.list': case 'listCatalog': return this.listCatalog(payload)
      case 'holiday.upsert': case 'upsertHolidayCalendar': return this.upsertHolidayCalendar(payload, options)
      case 'holiday.get': case 'getHolidayCalendar': return this.getHolidayCalendar(payload.year)
      case 'audit.list': case 'auditEvents': return this.auditEvents(payload)
      case 'outbox.list': case 'listOutbox': return this.listOutbox(payload)
      default: throw new SubscriptionError('ADMIN_ACTION_UNKNOWN', `未知管理 action: ${action}`, undefined, 400)
    }
  }

  async handleAdminRequest(req, res) {
    if (!req || !res) throw new SubscriptionError('HTTP_INVALID', 'HTTP 请求无效', undefined, 400)
    if (req.method !== 'POST') { sendJson(res, 404, { ok: false, code: 'NOT_FOUND' }); return }
    const supplied = requestHeader(req, ADMIN_TOKEN_HEADER)
    if (!this.verifyNativeAdminToken(supplied)) { sendJson(res, 403, { ok: false, code: 'NATIVE_ADMIN_REQUIRED', error: '只允许大神.app原生管理员调用' }); return }
    try {
      const body = await readRequestJson(req)
      const result = await this.dispatchAdmin(body)
      sendJson(res, 200, { ok: true, data: result })
    } catch (error) {
      sendJson(res, Number(error?.status) || (error instanceof SubscriptionError ? 400 : 500), { ok: false, code: error?.code || 'SUBSCRIPTION_ERROR', error: String(error?.message || error).slice(0, 1_000), details: error?.details })
    }
  }

  verifyNativeAdminToken(value) {
    if (typeof value !== 'string' || !value) return false
    const a = Buffer.from(value)
    const b = Buffer.from(this.nativeAdminToken)
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
  }

  async handleStatusRequest(req, res) {
    if (req.method !== 'GET') { sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }); return }
    sendJson(res, 200, this.adminStatus())
  }
}

export function requestHeader(req, name) {
  const headers = req?.headers || {}
  const target = String(name).toLowerCase()
  for (const [key, value] of Object.entries(headers)) if (String(key).toLowerCase() === target) return Array.isArray(value) ? String(value[0] || '') : String(value || '')
  return ''
}

export async function readRequestJson(req, maxBytes = 256 * 1024) {
  if (req?.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body
  if (typeof req?.body === 'string' || Buffer.isBuffer(req?.body)) return JSON.parse(String(req.body))
  if (typeof req?.json === 'function') return req.json()
  if (!req?.on) return {}
  const chunks = []
  let size = 0
  await new Promise((resolvePromise, reject) => {
    req.on('data', (chunk) => { size += Buffer.byteLength(chunk); if (size > maxBytes) reject(new SubscriptionError('BODY_TOO_LARGE', '请求体过大', undefined, 413)); else chunks.push(Buffer.from(chunk)) })
    req.on('end', resolvePromise)
    req.on('error', reject)
  })
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new SubscriptionError('BODY_INVALID', '请求体不是合法 JSON', undefined, 400) }
}

export function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  try { res.statusCode = status; res.setHeader?.('content-type', 'application/json; charset=utf-8'); res.end?.(body) } catch { /* test doubles may only expose a body field */ }
  return body
}

export function createSubscriptionService(options = {}) { return new DingTalkSubscriptionService(options) }
export const SubscriptionService = DingTalkSubscriptionService
export const DingtalkSubscriptionService = DingTalkSubscriptionService
export const createDingTalkSubscriptionService = createSubscriptionService
export const DEFAULT_DB = DEFAULT_DB_PATH
export const getSubscriptionsDbPath = defaultDbPath

export function createNativeAdminRoute(service) {
  return { kind: 'exact', path: ADMIN_API_PATH, handler: (req, res) => service.handleAdminRequest(req, res) }
}

export function createSubscriptionStatusRoute(service) {
  return { kind: 'exact', path: STATUS_API_PATH, handler: (req, res) => service.handleStatusRequest(req, res) }
}

export function createBrandAvatarRoute() {
  return {
    kind: 'exact',
    path: BRAND_AVATAR_API_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' }); return }
      const body = readFileSync(BRAND_ASSET_PATH)
      res.statusCode = 200
      res.setHeader?.('content-type', 'image/png')
      res.setHeader?.('cache-control', 'private, max-age=3600')
      res.setHeader?.('x-content-type-options', 'nosniff')
      res.end?.(body)
    },
  }
}

export async function resolveInjectedSecret(credentials, names = ['DSH_DINGTALK_IDENTITY_SECRET', 'DINGTALK_SUBSCRIBER_HMAC_SECRET']) {
  for (const name of names) {
    try {
      const value = await credentials?.resolve?.(name)
      const resolved = value && typeof value === 'object' ? value.value : value
      if (typeof resolved === 'string' && resolved.trim()) return resolved.trim()
    } catch { /* try next credential name */ }
  }
  for (const name of names) if (process.env[name]?.trim()) return process.env[name].trim()
  return undefined
}

export async function apply(ctx, config = {}) {
  const hmacSecret = config.hmacSecret || config.identitySecret || await resolveInjectedSecret(ctx?.credentials)
  const contextService = (names) => {
    for (const key of names) {
      try { if (ctx?.[key]) return ctx[key] } catch { /* scoped lookup below */ }
      try { const value = ctx?.get?.(key); if (value) return value } catch { /* optional service */ }
    }
    return null
  }
  const service = new DingTalkSubscriptionService({ ...config, hmacSecret, agentPresets: config.agentPresets || contextService(['agentPresets']), agentPresetsResolver: config.agentPresetsResolver || (() => contextService(['agentPresets'])), workspaceRegistry: config.workspaceRegistry || contextService(['workspaceRegistry', 'workspaces']), workspaceRegistryResolver: config.workspaceRegistryResolver || (() => contextService(['workspaceRegistry', 'workspaces'])), llm: config.llm || contextService(['llm']), llmResolver: config.llmResolver || (() => contextService(['llm'])), shrimpCatalog: config.shrimpCatalog || contextService(['shrimpCatalog', 'shrimpTankCatalog']), shrimpCatalogResolver: config.shrimpCatalogResolver || (() => contextService(['shrimpCatalog', 'shrimpTankCatalog'])), credentialWriter: config.credentialWriter || ctx?.credentials, credentialResolver: config.credentialResolver || ctx?.credentials, registrationManager: config.registrationManager || contextService(['dingtalkAccountManager']), registrationResolver: config.registrationResolver || (() => contextService(['dingtalkAccountManager'])) })
  const shrimpTankClient = config.shrimpTankClient || new ShrimpTankSubscriberClient({
    service,
    credentials: ctx?.credentials,
    baseUrl: config.shrimpTankBaseUrl,
    systemToken: config.shrimpTankSystemToken || service.shrimpTankSystemToken,
    systemTokenPath: service.shrimpTankSystemTokenPath,
    fetchImpl: config.fetchImpl,
    timeoutMs: config.shrimpTankTimeoutMs,
  })
  if (!service.shrimpCatalog) service.shrimpCatalog = shrimpTankClient
  const register = () => {
    const disposers = []
    if (ctx?.webServer?.register) {
      disposers.push(ctx.webServer.register(createNativeAdminRoute(service)))
      disposers.push(ctx.webServer.register(createSubscriptionStatusRoute(service)))
      disposers.push(ctx.webServer.register(createBrandAvatarRoute()))
    }
    if (typeof ctx?.on === 'function') disposers.push(ctx.on('tools/pre-execute', createSubscriberPreExecuteListener(service)))
    return () => disposers.forEach((dispose) => dispose?.())
  }
  const effect = () => {
    const disposeRoutes = register()
    const intervalMs = Math.max(5_000, Number(config.outboxIntervalMs || 15_000))
    const outboxTimer = config.disableOutboxProcessor === true ? null : setInterval(() => { void shrimpTankClient.drainOutbox({ limit: 20 }).catch(() => {}) }, intervalMs)
    outboxTimer?.unref?.()
    if (config.disableOutboxProcessor !== true) void shrimpTankClient.drainOutbox({ limit: 20 }).catch(() => {})
    return () => {
      disposeRoutes?.()
      if (outboxTimer) clearInterval(outboxTimer)
      service.close()
    }
  }
  let fallbackDispose
  if (typeof ctx?.effect === 'function') ctx.effect(effect, 'dsh-dingtalk-subscriptions: native admin and subscriber gates')
  else fallbackDispose = register()
  if (typeof ctx?.provide === 'function') {
    ctx.provide('dingtalkSubscriptions', service)
    ctx.provide('dshDingtalkSubscriptions', service)
    ctx.provide('dshDingtalkSubscriptionService', service)
    ctx.provide('dshDingtalkShrimpTankClient', shrimpTankClient)
  }
  try {
    const accountManager = contextService(['dingtalkAccountManager'])
    if (typeof accountManager?.reload === 'function') await accountManager.reload()
  } catch { /* the 30-second account-manager reconciliation remains the fallback */ }
  try {
    const currentYear = Number(dateKey(new Date()).slice(0, 4))
    const calendar = service.getHolidayCalendar(currentYear)
    if (calendar) service.enqueueOutbox({ kind: 'shrimptank.calendar.sync', aggregateId: String(currentYear), idempotencyKey: `calendar:${currentYear}:${calendar.sourceChecksum}`, payload: { year: currentYear } })
  } catch { /* missing future-year calendar deliberately fails closed */ }
  // Warm the administrator-only catalog without blocking Host startup.  A
  // failed 7843 connection leaves the cache empty; ordinary subscriber text
  // remains ordinary text until an exact authorized display name is present.
  void service.listCatalog().catch(() => {})
  // Cordis treats the resolved value of an async plugin apply() as an effect
  // disposer.  Returning the service object here makes Host boot fail with
  // "Invalid effect"; the service is available through ctx.provide instead.
  return fallbackDispose
}

export { SubscriptionStore, SubscriptionStoreError, DEFAULT_DB_PATH, DEFAULT_PRIVATE_ROOT, defaultDbPath }
export { BRAND_NAME as BRAND_ROBOT_NAME, BRAND_DESCRIPTION as BRAND_ROBOT_DESCRIPTION }
export { classifyProtectedContentRequest, evaluateSubscriberToolCall, detectProtectedContentDisclosure, workspacePathDecision }
export * from './calendar.js'
export * from './policy.js'
export * from './native-client.js'
export * from './shrimp-client.js'

export default { name, inject, apply }

import { addDays, isAllowedWorkdayFromCalendar } from './calendar.js'
import { readFileSync } from 'node:fs'

export const DEFAULT_SHRIMPTANK_BASE_URL = 'http://127.0.0.1:7843'
export const DEFAULT_SHRIMPTANK_TIMEOUT_MS = 5_000
export const MAX_SHRIMPTANK_RESPONSE_BYTES = 256 * 1024
export const SHRIMPTANK_ENDPOINTS = Object.freeze({
  publishedShrimps: '/api/v1/dsh/shrimps',
  upsertSubscriber: '/api/v1/system/subscribers',
  grantPipeline: (subscriberId, resourceId) => `/api/v1/system/subscribers/${encodeURIComponent(subscriberId)}/pipelines/${encodeURIComponent(resourceId)}:grant`,
  revokePipeline: (subscriberId, resourceId) => `/api/v1/system/subscribers/${encodeURIComponent(subscriberId)}/pipelines/${encodeURIComponent(resourceId)}:revoke`,
  state: (subscriberId, state) => `/api/v1/system/subscribers/${encodeURIComponent(subscriberId)}:${state === 'active' ? 'resume' : state}`,
  reconcile: (subscriberId) => `/api/v1/system/subscribers/${encodeURIComponent(subscriberId)}/reconciliation`,
  holiday: (year) => `/api/v1/system/subscriber-calendars/${encodeURIComponent(year)}`,
})

export class ShrimpTankClientError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'ShrimpTankClientError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function safeId(value) {
  const id = String(value ?? '').trim()
  if (!id || id.length > 300 || /[\u0000\r\n]/u.test(id)) throw new ShrimpTankClientError('SHRIMPTANK_ID_INVALID', 'ShrimpTank 标识无效')
  return id
}

function safeText(value, fallback = '') {
  const text = String(value ?? fallback).trim()
  return text.slice(0, 2_000)
}

function extractObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

function receiptFrom(value) {
  const root = extractObject(value)
  const nested = extractObject(root.subscriber || root.account || root.data)
  const accountId = root.account_id || root.accountId || nested.account_id || nested.accountId
  const userId = root.user_id || root.userId || nested.user_id || nested.userId
  return accountId && userId ? { accountId: safeId(accountId), userId: safeId(userId) } : null
}

function responseError(response, body) {
  const status = Number(response?.status || 0)
  const detail = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : ''
  return new ShrimpTankClientError('SHRIMPTANK_HTTP_ERROR', `ShrimpTank 请求失败${status ? `(${status})` : ''}${detail ? `: ${detail.slice(0, 300)}` : ''}`, { status })
}

export class ShrimpTankSubscriberClient {
  constructor(options = {}) {
    this.service = options.service
    if (!this.service) throw new ShrimpTankClientError('SERVICE_REQUIRED', 'ShrimpTank 客户端需要订阅服务')
    this.baseUrl = String(options.baseUrl || DEFAULT_SHRIMPTANK_BASE_URL).replace(/\/+$/u, '')
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/iu.test(this.baseUrl)) throw new ShrimpTankClientError('SHRIMPTANK_HOST_FORBIDDEN', 'ShrimpTank 客户端只允许 loopback 地址')
    this.credentials = options.credentials
    this.systemToken = options.systemToken
    this.systemTokenPath = options.systemTokenPath || null
    this.systemTokenEnv = options.systemTokenEnv || 'SHRIMP_TANK_SYSTEM_PRINCIPAL_TOKEN'
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.timeoutMs = Math.max(250, Number(options.timeoutMs || DEFAULT_SHRIMPTANK_TIMEOUT_MS))
    this.maxResponseBytes = Math.max(4_096, Number(options.maxResponseBytes || MAX_SHRIMPTANK_RESPONSE_BYTES))
    this.processingOutbox = new Set()
  }

  async resolveSystemToken() {
    if (typeof this.systemToken === 'function') {
      const value = await this.systemToken()
      if (typeof value === 'string' && value.trim()) return value.trim()
    } else if (typeof this.systemToken === 'string' && this.systemToken.trim()) return this.systemToken.trim()
    try {
      const value = await this.credentials?.resolve?.(this.systemTokenEnv)
      const token = value && typeof value === 'object' ? value.value : value
      if (typeof token === 'string' && token.trim()) return token.trim()
    } catch { /* fail closed below */ }
    const envValue = process.env[this.systemTokenEnv]
    if (typeof envValue === 'string' && envValue.trim()) return envValue.trim()
    if (this.systemTokenPath) {
      try {
        const fileValue = readFileSync(this.systemTokenPath, 'utf8').trim()
        if (fileValue) return fileValue
      } catch { /* fail closed below */ }
    }
    throw new ShrimpTankClientError('SHRIMPTANK_TOKEN_MISSING', 'ShrimpTank system token 未配置')
  }

  async request(path, options = {}) {
    if (typeof this.fetchImpl !== 'function') throw new ShrimpTankClientError('SHRIMPTANK_UNAVAILABLE', '当前 Node 环境没有 fetch')
    const token = await this.resolveSystemToken()
    const url = `${this.baseUrl}${String(path).startsWith('/') ? path : `/${path}`}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'X-DSH-System-Principal': token,
          'X-System-Principal-Token': token,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
          ...(options.headers || {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      })
      let raw = ''
      if (response?.body?.getReader) {
        const reader = response.body.getReader()
        const chunks = []
        let size = 0
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value?.byteLength || 0
          if (size > this.maxResponseBytes) throw new ShrimpTankClientError('SHRIMPTANK_RESPONSE_TOO_LARGE', 'ShrimpTank 响应过大')
          chunks.push(Buffer.from(part.value))
        }
        raw = Buffer.concat(chunks).toString('utf8')
      } else if (typeof response?.text === 'function') {
        raw = await response.text()
        if (Buffer.byteLength(raw, 'utf8') > this.maxResponseBytes) throw new ShrimpTankClientError('SHRIMPTANK_RESPONSE_TOO_LARGE', 'ShrimpTank 响应过大')
      }
      let body = {}
      if (raw.trim()) {
        try { body = JSON.parse(raw) } catch { throw new ShrimpTankClientError('SHRIMPTANK_RESPONSE_INVALID', 'ShrimpTank 返回的不是合法 JSON') }
      } else if (typeof response?.json === 'function') {
        try { body = await response.json() } catch { body = {} }
      }
      if (!response?.ok) throw responseError(response, body)
      if (body?.ok === false) throw responseError(response, body)
      return body
    } catch (error) {
      if (error instanceof ShrimpTankClientError) throw error
      if (error?.name === 'AbortError') throw new ShrimpTankClientError('SHRIMPTANK_TIMEOUT', 'ShrimpTank 请求超时')
      throw new ShrimpTankClientError('SHRIMPTANK_UNAVAILABLE', 'ShrimpTank 当前不可用')
    } finally {
      clearTimeout(timeout)
    }
  }

  async upsertSubscriber(input = {}) {
    const subscriberId = safeId(input.subscriberId)
    const subscriber = this.service.getSubscriber(subscriberId)
    const policy = this.service.resolveRuntimePolicy(subscriberId)
    const body = {
      subscriber_id: subscriberId,
      display_name: safeText(input.displayName || subscriber?.displayName, subscriberId),
      status: subscriber?.status || 'pending',
      workspace_root: policy.workspaceRoot || null,
      workspace_id: policy.workspaceId || null,
      weekly_token_limit: Number(subscriber?.weeklyTokenLimit || 0),
      entitlements: {
        modes: policy.allowedModes.map((item) => item.resourceId),
        workspaces: policy.allowedWorkspaces.map((item) => item.workspaceId),
        models: policy.allowedModels.map((item) => item.resourceId),
        efforts: policy.allowedEfforts.map((item) => item.resourceId),
      },
    }
    const existingMetadata = subscriber?.metadata || {}
    if (existingMetadata.shrimptankAccountId) body.account_id = existingMetadata.shrimptankAccountId
    if (existingMetadata.shrimptankUserId) body.user_id = existingMetadata.shrimptankUserId
    const response = await this.request(SHRIMPTANK_ENDPOINTS.upsertSubscriber, { method: 'POST', body })
    const receipt = receiptFrom(response)
    if (!receipt) throw new ShrimpTankClientError('SHRIMPTANK_RECEIPT_MISSING', 'ShrimpTank 未返回 account_id/user_id')
    const current = this.service.getSubscriber(subscriberId)
    const metadata = { ...(current?.metadata || {}), shrimptankAccountId: receipt.accountId, shrimptankUserId: receipt.userId, shrimptank_account_id: receipt.accountId, shrimptank_user_id: receipt.userId }
    if (current?.metadata?.shrimptankAccountId !== receipt.accountId || current?.metadata?.shrimptankUserId !== receipt.userId || current?.metadata?.shrimptank_account_id !== receipt.accountId || current?.metadata?.shrimptank_user_id !== receipt.userId) {
      this.service.updateSubscriber(subscriberId, { metadata }, { expectedRevision: current.revision })
    }
    return { ok: true, subscriberId, accountId: receipt.accountId, userId: receipt.userId }
  }

  async grantPipeline(input = {}) {
    const subscriberId = safeId(input.subscriberId)
    const resourceId = safeId(input.resourceId || input.pipelineSlug || input.slug)
    const displayName = safeText(input.displayName || input.pipelineSlug || resourceId, resourceId)
    let receipt
    try {
      const upsert = await this.upsertSubscriber({ subscriberId })
      receipt = { accountId: upsert.accountId, userId: upsert.userId }
    } catch (error) {
      const entitlement = this.service.grantEntitlement({ subscriberId, kind: 'shrimp', resourceId, displayName, metadata: { pipelineSlug: resourceId } })
      return { ok: false, pending: true, entitlement, code: error.code || 'SHRIMPTANK_UNAVAILABLE', error: error.message }
    }
    try {
      const published = await this.listPublished()
      this.service.setShrimpCatalog(published)
      if (published.length && !published.some((item) => String(item?.ref || item?.slug || item?.id || item?.resourceId) === resourceId)) throw new ShrimpTankClientError('SHRIMP_NOT_PUBLISHED', '该虾当前未在 ShrimpTank 已发布目录中')
    } catch (error) {
      if (error.code === 'SHRIMP_NOT_PUBLISHED') return { ok: false, pending: false, code: error.code, error: error.message }
      const entitlement = this.service.grantEntitlement({ subscriberId, kind: 'shrimp', resourceId, displayName, metadata: { pipelineSlug: resourceId } })
      return { ok: false, pending: true, entitlement, code: error.code || 'SHRIMPTANK_UNAVAILABLE', error: error.message }
    }
    const entitlement = this.service.grantEntitlement({ subscriberId, kind: 'shrimp', resourceId, displayName, metadata: { pipelineSlug: resourceId } })
    try {
      const remote = await this.request(SHRIMPTANK_ENDPOINTS.grantPipeline(subscriberId, resourceId), { method: 'POST', body: { subscriber_id: subscriberId, pipeline_slug: resourceId, display_name: displayName } })
      const remoteReceipt = receiptFrom(remote) || receipt || { accountId: null, userId: null }
      const active = this.service.activateEntitlement({ subscriberId, entitlementId: entitlement.entitlementId, receipt: remoteReceipt })
      return { ok: true, pending: false, entitlement: active, remote: { acknowledged: true, accountId: remoteReceipt.accountId, userId: remoteReceipt.userId } }
    } catch (error) {
      return { ok: false, pending: true, entitlement, code: error.code || 'SHRIMPTANK_UNAVAILABLE', error: error.message }
    }
  }

  async revokePipeline(input = {}) {
    const subscriberId = safeId(input.subscriberId)
    const resourceId = safeId(input.resourceId || input.pipelineSlug || input.slug)
    const entitlement = this.service.revokeEntitlement({ subscriberId, kind: 'shrimp', resourceId })
    try {
      await this.request(SHRIMPTANK_ENDPOINTS.revokePipeline(subscriberId, resourceId), { method: 'POST', body: { subscriber_id: subscriberId, pipeline_slug: resourceId } })
      return { ok: true, pending: false, entitlement }
    } catch (error) {
      return { ok: false, pending: true, entitlement, code: error.code || 'SHRIMPTANK_UNAVAILABLE', error: error.message }
    }
  }

  async _state(input, state) {
    const subscriberId = safeId(input.subscriberId || input)
    const local = state === 'suspended' ? this.service.suspendSubscriber(subscriberId) : state === 'active' ? this.service.resumeSubscriber(subscriberId) : this.service.revokeSubscriber(subscriberId)
    try {
      await this.request(SHRIMPTANK_ENDPOINTS.state(subscriberId, state), { method: 'POST', body: { subscriber_id: subscriberId, state } })
      return { ok: true, pending: false, subscriber: local }
    } catch (error) {
      const outbox = this.service.enqueueOutbox({ kind: `shrimptank.subscriber.${state}`, aggregateId: subscriberId, idempotencyKey: `subscriber-state:${subscriberId}:${state}:${local.revision}`, payload: { subscriberId, state } })
      this.service.markOutbox(outbox.outboxId, 'failed', { error: error.code || 'SHRIMPTANK_UNAVAILABLE' })
      return { ok: false, pending: true, subscriber: local, code: error.code || 'SHRIMPTANK_UNAVAILABLE', error: error.message }
    }
  }

  suspendSubscriber(input) { return this._state(input, 'suspended') }
  resumeSubscriber(input) { return this._state(input, 'active') }
  revokeSubscriber(input) { return this._state(input, 'revoked') }

  async reconcile(input = {}) {
    const subscriberId = safeId(input.subscriberId || input)
    try {
      const remote = await this.request(SHRIMPTANK_ENDPOINTS.reconcile(subscriberId), { method: 'GET' })
      return { ok: true, pending: false, subscriberId, remote }
    } catch (error) {
      return { ok: false, pending: true, subscriberId, code: error.code || 'SHRIMPTANK_UNAVAILABLE', error: error.message }
    }
  }

  async listPublished() {
    const response = await this.request(SHRIMPTANK_ENDPOINTS.publishedShrimps, { method: 'GET' })
    const root = extractObject(response)
    const data = extractObject(root.data)
    const items = Array.isArray(response) ? response : Array.isArray(root.items) ? root.items : Array.isArray(root.shrimps) ? root.shrimps : Array.isArray(root.data) ? root.data : Array.isArray(data.items) ? data.items : Array.isArray(data.shrimps) ? data.shrimps : []
    return items.filter((item) => {
      const lifecycle = String(item?.lifecycle_status || item?.lifecycle || item?.status || 'published').toLowerCase()
      return !['draft', 'archived', 'deleted'].includes(lifecycle)
    })
  }

  async syncCalendar(year) {
    const calendar = this.service.getHolidayCalendar(year)
    if (!calendar) throw new ShrimpTankClientError('HOLIDAY_CALENDAR_MISSING', '本机缺少该年份的国务院节假日日历')
    const entries = []
    const start = `${calendar.year}-01-01`
    const end = `${calendar.year + 1}-01-01`
    for (let day = start; day < end; day = addDays(day, 1)) entries.push({ date: day, is_workday: isAllowedWorkdayFromCalendar(day, calendar) })
    try {
      const remote = await this.request(SHRIMPTANK_ENDPOINTS.holiday(calendar.year), { method: 'PUT', body: { year: calendar.year, timezone: calendar.timezone, source_url: calendar.sourceUrl, source_checksum: calendar.sourceChecksum, entries } })
      return { ok: true, pending: false, calendar, remote }
    } catch (error) {
      return { ok: false, pending: true, calendar, code: error.code || 'SHRIMPTANK_UNAVAILABLE', error: error.message }
    }
  }

  async syncFullYear(year) { return this.syncCalendar(year) }

  async reconcileAll(options = {}) {
    const subscribers = this.service.listSubscribers().filter((item) => !['revoked', 'suspended'].includes(item.status))
    const results = []
    for (const subscriber of subscribers.slice(0, Number(options.limit || 100))) results.push(await this.reconcile({ subscriberId: subscriber.subscriberId }))
    return { ok: results.every((item) => item.ok), results }
  }

  async syncSubscriber(input = {}) { return this.upsertSubscriber(input) }

  async drainOutbox(options = {}) {
    const limit = Math.max(1, Math.min(50, Number(options.limit || 20)))
    const maxAttempts = Math.max(1, Math.min(10, Number(options.maxAttempts || 6)))
    const now = Date.now()
    const staleProcessingBefore = now - Math.max(30_000, this.timeoutMs * 2)
    const rows = this.service.listOutbox({ limit: Math.max(limit * 3, limit) }).filter((item) => item.kind?.startsWith('shrimptank.') && (['pending', 'failed'].includes(item.status) || (item.status === 'processing' && Date.parse(item.updatedAt || 0) <= staleProcessingBefore)) && !this.processingOutbox.has(item.outboxId) && Number(item.attempts || 0) < maxAttempts && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now)).slice(0, limit)
    const results = []
    for (const row of rows) {
      this.processingOutbox.add(row.outboxId)
      try { this.service.markOutbox(row.outboxId, 'processing') } catch { this.processingOutbox.delete(row.outboxId); continue }
      try {
        const payload = row.payload || {}
        if (row.kind === 'shrimptank.subscriber.sync') await this.upsertSubscriber({ subscriberId: payload.subscriberId || row.aggregateId })
        else if (row.kind === 'shrimptank.pipeline.grant') {
          const result = await this.grantPipeline({ subscriberId: payload.subscriberId || row.aggregateId, resourceId: payload.resourceId, displayName: payload.displayName })
          if (!result.ok) throw new ShrimpTankClientError(result.code || 'SHRIMPTANK_GRANT_PENDING', '虾授权仍待 ShrimpTank 回执')
        } else if (row.kind === 'shrimptank.pipeline.revoke') {
          await this.request(SHRIMPTANK_ENDPOINTS.revokePipeline(payload.subscriberId || row.aggregateId, payload.resourceId), { method: 'POST', body: { subscriber_id: payload.subscriberId || row.aggregateId, pipeline_slug: payload.resourceId } })
        } else if (row.kind?.startsWith('shrimptank.subscriber.')) {
          const state = row.kind.slice('shrimptank.subscriber.'.length)
          await this.request(SHRIMPTANK_ENDPOINTS.state(payload.subscriberId || row.aggregateId, state), { method: 'POST', body: { subscriber_id: payload.subscriberId || row.aggregateId, state } })
        } else if (row.kind === 'shrimptank.calendar.sync') {
          const result = await this.syncCalendar(payload.year)
          if (!result.ok) throw new ShrimpTankClientError(result.code || 'SHRIMPTANK_CALENDAR_PENDING', 'ShrimpTank 年历同步仍待处理')
        } else {
          throw new ShrimpTankClientError('SHRIMPTANK_OUTBOX_UNKNOWN', '未知 ShrimpTank outbox 类型')
        }
        this.service.markOutbox(row.outboxId, 'completed')
        results.push({ outboxId: row.outboxId, ok: true })
      } catch (error) {
        const attempt = Number(row.attempts || 0) + 1
        const delayMs = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(8, attempt))
        try { this.service.markOutbox(row.outboxId, 'failed', { error: error.code || 'SHRIMPTANK_SYNC_FAILED', nextAttemptAt: new Date(Date.now() + delayMs).toISOString() }) } catch { /* retain pending state for a later operator retry */ }
        results.push({ outboxId: row.outboxId, ok: false, pending: true, code: error.code || 'SHRIMPTANK_SYNC_FAILED' })
      } finally {
        this.processingOutbox.delete(row.outboxId)
      }
    }
    return { ok: results.every((item) => item.ok), processed: results.length, results }
  }
}

export function createShrimpTankSubscriberClient(options = {}) { return new ShrimpTankSubscriberClient(options) }

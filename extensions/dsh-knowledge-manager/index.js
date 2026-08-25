// dsh-knowledge-manager — Host half
//
// The management UI deliberately owns all mutations.  The only model-facing
// tool registered here is read-only (list/get/search), so a prompt or an
// image-derived instruction can never create, edit, archive, or delete a KB.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-knowledge-manager'
export const inject = ['tools']

const TANK_URL = process.env.SHRIMP_TANK_BASE_URL || 'http://127.0.0.1:7843'
const ID = '[A-Za-z0-9_.:-]+'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function safeTankBaseUrl(value = TANK_URL) {
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || !LOCAL_HOSTS.has(parsed.hostname)) throw new Error('虾缸只允许访问本机 HTTP(S) 服务')
  parsed.pathname = parsed.pathname.replace(/\/$/, '')
  parsed.search = ''
  parsed.hash = ''
  return parsed
}

// Keep this list deliberately narrow.  The browser uses the shrimp-shell
// same-origin proxy, while this host tool has the same read-only boundary.
export const KNOWLEDGE_READ_RULES = Object.freeze([
  ['GET', /^\/api\/v1\/knowledge-bases$/],
  ['GET', new RegExp(`^\\/api\\/v1\\/knowledge-bases\\/${ID}$`)],
  ['POST', new RegExp(`^\\/api\\/v1\\/knowledge-bases\\/${ID}\\/search$`)],
])

export function knowledgeReadPathAllowed(method, path) {
  let decoded = String(path || '')
  try { decoded = decodeURIComponent(decoded) } catch { return false }
  return KNOWLEDGE_READ_RULES.some(([verb, pattern]) => verb === String(method || '').toUpperCase() && pattern.test(decoded))
}

export function knowledgeId(value) {
  const id = String(value || '').trim()
  return /^[A-Za-z0-9_.:-]+$/.test(id) ? id : ''
}

export function apiErrorFromPayload(payload, status = 500) {
  const detail = payload && payload.detail
  const code = String((detail && detail.code) || payload?.code || `HTTP_${status}`)
  const message = String((detail && detail.message) || payload?.message || payload?.error || '知识库请求失败')
  return { code, message: message.slice(0, 500), status }
}

function envelopeData(value) {
  return value && value.schema === 'api_envelope.v1' ? value.data : value
}

async function readResponse(response) {
  const contentType = response.headers?.get?.('content-type') || ''
  let payload = null
  try {
    payload = contentType.includes('json') ? await response.json() : await response.text()
  } catch {
    payload = null
  }
  if (!response.ok) {
    const failure = apiErrorFromPayload(payload && typeof payload === 'object' ? payload : { error: String(payload || '') }, response.status)
    return { ok: false, ...failure }
  }
  return { ok: true, status: response.status, data: envelopeData(payload) }
}

export async function readKnowledgeBase({ action = 'list', id = '', query = '', topK = 8, fetchImpl = fetch } = {}) {
  let path
  let method = 'GET'
  let body
  const safeId = knowledgeId(id)
  if (action === 'list') path = '/api/v1/knowledge-bases'
  else if (action === 'get' && safeId) path = `/api/v1/knowledge-bases/${encodeURIComponent(safeId)}`
  else if (action === 'search' && safeId && String(query || '').trim()) {
    path = `/api/v1/knowledge-bases/${encodeURIComponent(safeId)}/search`
    method = 'POST'
    body = JSON.stringify({ query: String(query).trim().slice(0, 2000), top_k: Math.max(1, Math.min(20, Number(topK) || 8)), max_context_tokens: 4096 })
  } else {
    return { ok: false, code: 'KNOWLEDGE_READ_INPUT_INVALID', error: '只支持 list、get、search；get/search 必须提供有效知识库 id，search 还需要 query' }
  }
  if (!knowledgeReadPathAllowed(method, path)) return { ok: false, code: 'KNOWLEDGE_READ_PATH_DENIED', error: '知识库只读路径未通过 allowlist' }
  const headers = { Accept: 'application/json' }
  if (body) {
    headers['Content-Type'] = 'application/json'
    headers['Idempotency-Key'] = `dsh-kb-read:${safeId}:${Date.now()}:${randomUUID()}`
  }
  try {
    const response = await fetchImpl(new URL(path, safeTankBaseUrl()), {
      method,
      headers,
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(30_000),
    })
    const result = await readResponse(response)
    return result.ok ? { ok: true, action, data: result.data } : { ok: false, code: result.code, error: result.message, status: result.status }
  } catch (error) {
    return { ok: false, code: 'KNOWLEDGE_READ_OFFLINE', offline: true, error: String(error?.message || error).slice(0, 500) }
  }
}

export function apply(ctx) {
  if (!ctx?.tools?.register) return
  ctx.tools.register(defineTool({
    name: 'knowledge_bases',
    description: '只读读取虾缸知识库列表、单库元数据或在指定知识库内检索。不能新增、修改、归档、删除知识库；所有写操作必须由知识库管理面板中的明确按钮触发。',
    parameters: {
      action: { type: 'string', required: true, description: 'list、get 或 search' },
      id: { type: 'string', description: 'get/search 的知识库 id' },
      query: { type: 'string', description: 'search 的查询内容' },
      topK: { type: 'number', description: 'search 返回条数，1-20，默认 8' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean', required: true }, action: { type: 'string' }, data: { type: 'object', additionalProperties: true }, error: { type: 'string' }, code: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value || {}, null, 2).slice(0, 16_000) }],
    },
    timeoutMs: 35_000,
    async execute(args) {
      return readKnowledgeBase(args)
    },
    presentCall(args) { return { card: 'generic', title: `知识库只读：${String(args?.action || 'list')}` } },
  }))
}

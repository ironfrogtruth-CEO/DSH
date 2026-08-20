/**
 * dsh-code-intelligence — Host-only, explicitly invoked local code index.
 *
 * No client half, no conversation hook, and no automatic context injection.
 * The tools return bounded, provenance-bearing candidates only.
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CodeIndexStore } from './store.js'

export const name = 'dsh-code-intelligence'
export const inject = ['tools']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
let defineToolPromise
let store
let storeRoot

async function resolveDefineTool() {
  if (!defineToolPromise) defineToolPromise = (async () => {
    try {
      const module = await import('@deepseek-ai/dsh-tools')
      if (typeof module.defineTool === 'function') return module.defineTool
    } catch { /* resolve through the fixed Harness install below */ }
    const candidates = [
      join(DSH_HOME, 'profiles/web/node_modules/@deepseek-ai/dsh-tools'),
      join(DSH_HOME, 'profiles/node_modules/@deepseek-ai/dsh-tools'),
      join(DSH_HOME, 'install/node_modules/@deepseek-ai/dsh-tools'),
    ]
    for (const candidate of candidates) {
      try {
        const loaded = createRequire(join(DSH_HOME, 'code-intelligence-runtime.cjs'))(candidate)
        if (typeof loaded.defineTool === 'function') return loaded.defineTool
      } catch { /* try the next fixed installation location */ }
    }
    throw new Error('dsh-code-intelligence requires @deepseek-ai/dsh-tools at Host runtime')
  })()
  return defineToolPromise
}

function getStorageRoot() {
  return process.env.DSH_CODE_INTELLIGENCE_ROOT || join(DSH_HOME, 'code-intelligence')
}

function getStore() {
  const configuredRoot = getStorageRoot()
  if (store && storeRoot !== configuredRoot) disposeStore()
  if (!store) {
    store = new CodeIndexStore({ storageRoot: configuredRoot })
    storeRoot = configuredRoot
  }
  return store
}

function disposeStore() {
  const current = store
  store = undefined
  storeRoot = undefined
  if (!current) return
  try { current.close() } catch { /* reload cleanup must remain idempotent */ }
}

function errorResult(error) {
  return {
    ok: false,
    code: error?.code || 'CODE_INDEX_ERROR',
    error: String(error?.message || error).slice(0, 1_500),
    untrusted: true,
  }
}

const outputSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    code: { type: 'string' },
    error: { type: 'string' },
    provenance: { type: 'object', additionalProperties: true },
  },
}

const RENDER_LIMIT = 12_000

function sanitizeRenderValue(value, key = '') {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length > 600 ? `${value.slice(0, 600)}…` : value
  if (Array.isArray(value)) {
    const items = value.slice(0, 40).map((item) => sanitizeRenderValue(item, key))
    if (value.length > 40) items.push(`[${value.length - 40} more items]`)
    return items
  }
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([childKey]) => !['content', 'sourceText', 'text', 'body', 'fileContent'].includes(childKey)).map(([childKey, childValue]) => [childKey, sanitizeRenderValue(childValue, childKey)]))
  return String(value)
}

function boundedRenderJson(value, keys) {
  const selected = {}
  for (const key of keys) if (value && Object.prototype.hasOwnProperty.call(value, key)) selected[key] = sanitizeRenderValue(value[key], key)
  selected.truncated = false
  let text = JSON.stringify(selected)
  if (text.length <= RENDER_LIMIT) return text
  const compact = { truncated: true }
  for (const key of keys) {
    if (!value || !Object.prototype.hasOwnProperty.call(value, key)) continue
    const item = sanitizeRenderValue(value[key], key)
    compact[key] = Array.isArray(item) ? item.slice(0, 5) : (item && typeof item === 'object' ? { ok: item.ok, count: Object.keys(item).length } : item)
  }
  text = JSON.stringify(compact)
  return text.length <= RENDER_LIMIT ? text : JSON.stringify({ ok: value?.ok === true, truncated: true, code: value?.code ?? null })
}

function toolSpec({ name: toolName, description, parameters, execute, title, renderKeys }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: 'text', text: boundedRenderJson(value, renderKeys) }],
    },
    timeoutMs: 60_000,
    execute,
    presentCall() { return { card: 'generic', title } },
  }
}

const scopeParameters = {
  projectId: { type: 'string', required: true, description: '稳定项目隔离键；不会默认使用当前项目' },
  workspaceRoot: { type: 'string', required: true, description: '工作区绝对路径；必须是 Git 仓库且不能越出该目录' },
  branch: { type: 'string', description: '可选 Git branch；不填时读取当前 branch' },
}

export async function apply(ctx) {
  const defineTool = await resolveDefineTool()
  if (typeof ctx.effect !== 'function') throw new Error('dsh-code-intelligence requires ctx.effect for Host store cleanup')
  ctx.effect(() => () => disposeStore(), 'dsh-code-intelligence.store')
  const { tools } = ctx
  const register = (spec) => tools.register(defineTool(spec))
  const run = (fn) => async (args) => {
    try { return fn(args || {}) } catch (error) { return errorResult(error) }
  }

  register(toolSpec({
    name: 'code_index_build',
    title: 'Build code index',
    description: '显式扫描指定 Git 工作区并增量更新本地 SQLite/WAL/FTS5 代码索引；不会自动注入会话上下文。代码内容和结果均标记为 untrusted。',
    parameters: {
      ...scopeParameters,
      maxFileBytes: { type: 'integer', description: '单文件最大字节数，默认 1000000；超限跳过' },
      extensions: { type: 'array', description: '可选受控扩展名列表；不填使用内置语言白名单' },
    },
    renderKeys: ['ok', 'added', 'updated', 'unchanged', 'deleted', 'skipped', 'listed', 'indexed', 'projectId', 'workspaceRoot', 'branch', 'dbPath', 'provider', 'skippedByReason', 'provenance', 'disclaimer', 'code', 'error'],
    execute: run((args) => getStore().build(args)),
  }))

  register(toolSpec({
    name: 'code_index_status',
    title: 'Code index status',
    description: '显式读取一个 projectId + workspaceRoot + branch 的索引状态、文件/符号/导入计数和最近构建信息。',
    parameters: scopeParameters,
    renderKeys: ['ok', 'projectId', 'workspaceRoot', 'branch', 'indexed', 'files', 'symbols', 'imports', 'lastBuildAt', 'lastBuild', 'dbPath', 'journalMode', 'scope', 'provenance', 'disclaimer', 'code', 'error'],
    execute: run((args) => getStore().status(args)),
  }))

  register(toolSpec({
    name: 'code_index_query',
    title: 'Query code index',
    description: '显式查询指定索引；使用 FTS5、路径、符号和导入的混合评分，返回带 hash/provenance/untrusted 的候选文件。',
    parameters: {
      ...scopeParameters,
      query: { type: 'string', required: true, description: '路径、符号名或导入名查询词' },
      limit: { type: 'integer', description: '返回数量上限，默认 20，最大 100' },
    },
    renderKeys: ['ok', 'query', 'results', 'complete', 'candidate', 'disclaimer', 'ranking', 'provenance', 'code', 'error'],
    execute: run((args) => getStore().query(args)),
  }))

  register(toolSpec({
    name: 'code_repo_map',
    title: 'Code repository map',
    description: '显式生成 token-bounded 仓库地图；只包含路径、语言、摘要符号和来源 hash，不读取全量文件内容。',
    parameters: {
      ...scopeParameters,
      maxTokens: { type: 'integer', description: 'token 预算，默认 2000，最大 32000' },
    },
    renderKeys: ['ok', 'tokenEstimate', 'maxTokens', 'truncated', 'filesIndexed', 'filesIncluded', 'complete', 'candidate', 'disclaimer', 'provenance', 'code', 'error'],
    execute: run((args) => getStore().repoMap(args)),
  }))

  register(toolSpec({
    name: 'code_test_impact',
    title: 'Code test impact candidates',
    description: '显式计算变更文件的保守测试影响候选；仅依据 imports、symbol 名、同目录和 test/spec 命名，绝不宣称完整依赖图。',
    parameters: {
      ...scopeParameters,
      changedPaths: { type: 'array', required: true, description: '工作区相对变更路径数组' },
      limit: { type: 'integer', description: '候选数量上限，默认 30，最大 100' },
    },
    renderKeys: ['ok', 'changedPaths', 'candidates', 'complete', 'candidate', 'method', 'disclaimer', 'provenance', 'code', 'error'],
    execute: run((args) => getStore().testImpact(args)),
  }))
}

export { CodeIndexStore }

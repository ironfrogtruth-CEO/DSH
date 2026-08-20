/** Host-only explicit design and visual QA tools. No browser, UI, or page mutation. */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'

import { canonicalArtifactPath } from './artifacts.js'
import { visualDiff } from './png-diff.js'
import { evaluateFrontendSignoff, validateDesignQAManifest, validateDesignSystemManifest } from './schemas.js'

export const name = 'dsh-frontend-qa'
export const inject = ['tools']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
let defineToolPromise

async function resolveDefineTool() {
  if (!defineToolPromise) defineToolPromise = (async () => {
    try {
      const module = await import('@deepseek-ai/dsh-tools')
      if (typeof module.defineTool === 'function') return module.defineTool
    } catch { /* resolve through fixed Harness install paths */ }
    for (const candidate of [
      join(DSH_HOME, 'profiles/web/node_modules/@deepseek-ai/dsh-tools'),
      join(DSH_HOME, 'profiles/node_modules/@deepseek-ai/dsh-tools'),
      join(DSH_HOME, 'install/node_modules/@deepseek-ai/dsh-tools'),
    ]) {
      try {
        const loaded = createRequire(join(DSH_HOME, 'frontend-qa-runtime.cjs'))(candidate)
        if (typeof loaded.defineTool === 'function') return loaded.defineTool
      } catch { /* continue */ }
    }
    throw new Error('dsh-frontend-qa requires @deepseek-ai/dsh-tools at Host runtime')
  })()
  return defineToolPromise
}

const outputSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    code: { type: 'string' },
    error: { type: 'string' },
    errors: { type: 'array' },
    warnings: { type: 'array' },
  },
}

const RENDER_LIMIT = 12_000

function sanitizeRenderValue(value, key = '') {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (/(?:base64|image|png|jpeg|jpg|webp|html|page.?content|body)/i.test(key)) return '[redacted-content]'
    const redacted = value.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/gi, '[redacted-image]')
    return redacted.length > 600 ? `${redacted.slice(0, 600)}…` : redacted
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 40).map((item) => sanitizeRenderValue(item, key))
    if (value.length > 40) items.push(`[${value.length - 40} more items]`)
    return items
  }
  if (typeof value === 'object') {
    const output = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      if (/^(?:image|png|jpeg|jpg|webp|base64|html|page.?content|body|screenshot(?:Path|Data|Bytes))$/i.test(childKey)) continue
      output[childKey] = sanitizeRenderValue(childValue, childKey)
    }
    return output
  }
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
    if (Array.isArray(item)) compact[key] = item.slice(0, 5)
    else if (item && typeof item === 'object') compact[key] = { ok: item.ok, status: item.status, code: item.code, count: Object.keys(item).length }
    else compact[key] = item
  }
  text = JSON.stringify(compact)
  if (text.length <= RENDER_LIMIT) return text
  return JSON.stringify({ ok: value?.ok === true, truncated: true, schema: value?.schema ?? null, code: value?.code ?? null })
}

const pathParameters = {
  workspaceRoot: { type: 'string', required: true, description: '调用者工作区绝对路径；artifact 不能逃逸' },
  allowedRoot: { type: 'string', description: '可选显式额外 artifact 根目录' },
}

function toolSpec({ name: toolName, title, description, parameters, execute, renderKeys }) {
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

function errorResult(error) {
  return { ok: false, code: error?.code || 'FRONTEND_QA_ERROR', error: String(error?.message || error).slice(0, 1_500) }
}

function canonicalManifestPath(args) {
  if (typeof args.manifestPath !== 'string' || !args.manifestPath.trim()) throw new Error('manifestPath is required when manifest object is not supplied')
  return canonicalArtifactPath({ workspaceRoot: args.workspaceRoot, artifactPath: args.manifestPath, allowedRoot: args.allowedRoot }).path
}

function loadManifest(args) {
  if (args.manifest !== undefined) {
    if (!args.manifest || typeof args.manifest !== 'object' || Array.isArray(args.manifest)) throw new Error('manifest must be an object')
    return { value: args.manifest, path: null }
  }
  const path = canonicalManifestPath(args)
  return { value: JSON.parse(readFileSync(path, 'utf8')), path }
}

function validateReferencedPaths(manifest, args) {
  const errors = []
  const paths = []
  for (const item of manifest.screenshots ?? []) if (item.path) paths.push(['screenshots', item.path])
  for (const item of manifest.visualDiffs ?? []) {
    if (item.baselinePath) paths.push(['visualDiffs.baselinePath', item.baselinePath])
    if (item.actualPath) paths.push(['visualDiffs.actualPath', item.actualPath])
    if (item.diffPath) paths.push(['visualDiffs.diffPath', item.diffPath])
  }
  if (manifest.trace?.path) paths.push(['trace.path', manifest.trace.path])
  for (const [label, artifactPath] of paths) {
    try {
      const canonical = canonicalArtifactPath({ workspaceRoot: args.workspaceRoot, artifactPath, allowedRoot: args.allowedRoot })
      if (!readableFile(canonical.path)) errors.push(`${label} does not exist or is not a regular file: ${artifactPath}`)
    } catch (error) {
      errors.push(`${label}: ${error.message}`)
    }
  }
  return errors
}

function readableFile(path) {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

function runSafely(fn) {
  return async (args) => {
    try { return fn(args ?? {}) } catch (error) { return errorResult(error) }
  }
}

export async function apply(ctx) {
  const defineTool = await resolveDefineTool()
  const { tools } = ctx
  const register = (spec) => tools.register(defineTool(spec))

  register(toolSpec({
    name: 'frontend_design_validate',
    title: 'Design system validation',
    description: '显式校验 DesignSystemManifest v1 的字体、色彩、spacing、radius、elevation、icon、motion 和 breakpoint 合同；不会打开页面或注入上下文。',
    parameters: { ...pathParameters, manifestPath: { type: 'string', description: 'JSON manifest 路径；也可直接传 manifest 对象' }, manifest: { type: 'object', additionalProperties: true } },
    renderKeys: ['ok', 'schema', 'errors', 'warnings', 'manifestPath', 'explicit', 'code', 'error'],
    execute: runSafely((args) => {
      const loaded = loadManifest(args)
      const validation = validateDesignSystemManifest(loaded.value)
      return { ...validation, manifestPath: loaded.path, explicit: true }
    }),
  }))

  register(toolSpec({
    name: 'frontend_qa_validate',
    title: 'Frontend QA manifest validation',
    description: '显式校验 DesignQAManifest v2 的 viewports/themes/states/screenshots/visualDiffs/console/page/network/a11y/interactions/trace/reviewed/verdict 与 artifact 路径边界。',
    parameters: { ...pathParameters, manifestPath: { type: 'string', description: 'JSON QA manifest 路径；也可直接传 manifest 对象' }, manifest: { type: 'object', additionalProperties: true } },
    renderKeys: ['ok', 'schema', 'errors', 'warnings', 'manifestPath', 'manifestSummary', 'explicit', 'code', 'error'],
    execute: runSafely((args) => {
      const loaded = loadManifest(args)
      const validation = validateDesignQAManifest(loaded.value)
      const pathErrors = validation.ok ? validateReferencedPaths(loaded.value, args) : []
      const manifestSummary = {
        viewports: loaded.value.viewports?.length ?? 0,
        themes: loaded.value.themes?.length ?? 0,
        states: loaded.value.states?.length ?? 0,
        screenshots: loaded.value.screenshots?.length ?? 0,
        visualDiffs: loaded.value.visualDiffs?.length ?? 0,
        console: loaded.value.console?.length ?? 0,
        network: loaded.value.network?.length ?? 0,
        a11y: loaded.value.a11y?.length ?? 0,
        interactions: loaded.value.interactions?.length ?? 0,
        reviewed: loaded.value.reviewed === true,
        verdict: loaded.value.verdict ?? null,
      }
      return { ...validation, ok: validation.ok && pathErrors.length === 0, errors: [...validation.errors, ...pathErrors], manifestPath: loaded.path, manifestSummary, explicit: true }
    }),
  }))

  register(toolSpec({
    name: 'frontend_visual_diff',
    title: 'Frontend PNG visual diff',
    description: '显式比较两个 PNG artifact；尺寸不一致直接失败，输出 diffPixels/diffRatio/dimensions。可选写入 diffPath，但不会修改页面。',
    parameters: {
      ...pathParameters,
      baselinePath: { type: 'string', required: true, description: '基线 PNG 路径' },
      actualPath: { type: 'string', required: true, description: '实际 PNG 路径' },
      diffPath: { type: 'string', description: '可选差异 PNG 输出路径' },
      threshold: { type: 'number', description: '单像素通道差阈值 0-1，默认 0.1' },
    },
    renderKeys: ['ok', 'code', 'diffPixels', 'diffRatio', 'dimensions', 'baselinePath', 'actualPath', 'diffPath', 'baselineHash', 'actualHash', 'explicit', 'error'],
    execute: runSafely((args) => {
      const baseline = canonicalArtifactPath({ workspaceRoot: args.workspaceRoot, artifactPath: args.baselinePath, allowedRoot: args.allowedRoot }).path
      const actual = canonicalArtifactPath({ workspaceRoot: args.workspaceRoot, artifactPath: args.actualPath, allowedRoot: args.allowedRoot }).path
      const diff = args.diffPath ? canonicalArtifactPath({ workspaceRoot: args.workspaceRoot, artifactPath: args.diffPath, allowedRoot: args.allowedRoot }).path : null
      if (diff) mkdirSync(dirname(diff), { recursive: true })
      return { ...visualDiff({ baselinePath: baseline, actualPath: actual, diffPath: diff, threshold: args.threshold }), baselinePath: baseline, actualPath: actual, diffPath: diff, explicit: true }
    }),
  }))

  register(toolSpec({
    name: 'frontend_signoff',
    title: 'Frontend QA signoff',
    description: '显式执行 functional/visual/a11y 三道 signoff gate；未 review 截图、console/network 错误、关键 interaction 失败或严重 a11y 问题不得通过。',
    parameters: { ...pathParameters, manifestPath: { type: 'string', description: 'JSON QA manifest 路径；也可直接传 manifest 对象' }, manifest: { type: 'object', additionalProperties: true } },
    renderKeys: ['ok', 'functional', 'visual', 'a11y', 'blockers', 'verdict', 'manifestPath', 'explicit', 'code', 'error'],
    execute: runSafely((args) => {
      const loaded = loadManifest(args)
      const pathErrors = validateReferencedPaths(loaded.value, args)
      const signoff = evaluateFrontendSignoff(loaded.value)
      if (pathErrors.length) {
        signoff.ok = false
        signoff.blockers = [...signoff.blockers, ...pathErrors]
        signoff.visual = { ...signoff.visual, ok: false, pathErrors }
      }
      return { ok: signoff.ok, ...signoff, manifestPath: loaded.path, explicit: true }
    }),
  }))
}

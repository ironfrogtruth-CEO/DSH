/** Host-only offline evaluation tools; no client half and no automatic injection. */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { assertLosslessJson, compareEvaluations, DEFAULTS, listEvaluations, normalizeLosslessJson, runEvaluation } from './runner.js'
import { renderEvalResult } from './render.js'

export const name = 'dsh-evals'
export const inject = ['tools']

const DSH_ROOT = process.env.DSH_HOME || join(homedir(), '.dsh')

function resolveDefineTool() {
  const require = createRequire(import.meta.url)
  const candidates = [
    '@deepseek-ai/dsh-tools',
    join(DSH_ROOT, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools'),
    join(DSH_ROOT, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools'),
    join(DSH_ROOT, 'install', 'node_modules', '@deepseek-ai', 'dsh-tools'),
  ]
  for (const candidate of candidates) {
    try {
      const module = require(candidate)
      if (typeof module.defineTool === 'function') return module.defineTool
    } catch { /* try next local runtime root */ }
  }
  return null
}

function errorResult(error) {
  const result = { ok: false, code: error?.code || 'EVAL_ERROR', error: String(error?.message || error).slice(0, 1_000) }
  const normalized = normalizeLosslessJson(result)
  assertLosslessJson(normalized)
  return normalized
}

function toolResult(value) {
  const normalized = normalizeLosslessJson(value)
  assertLosslessJson(normalized)
  return normalized
}

const outputSchema = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean', required: true }, code: { type: 'string' }, error: { type: 'string' } },
}

function registerTool(tools, defineTool, spec) {
  tools.register(defineTool({
    ...spec,
    output: {
      schema: outputSchema,
      render: (_args, value) => renderEvalResult(spec.name, value),
    },
    timeoutMs: 30_000,
    presentCall() { return { card: 'generic', title: spec.title || spec.name } },
  }))
}

export async function apply(ctx) {
  const defineTool = resolveDefineTool()
  if (!defineTool || !ctx?.tools?.register) return undefined
  registerTool(ctx.tools, defineTool, {
    name: 'eval_run',
    title: 'Run offline eval',
    description: '显式运行一个 allowedRoot 内的离线 fixture 评测；不联网、不使用 LLM judge、不读取正式数据。',
    parameters: {
      fixtureId: { type: 'string', description: '内置 fixture ID' },
      fixturePath: { type: 'string', description: 'allowedRoot 内的 fixture 相对路径' },
      allowedRoot: { type: 'string', description: 'fixture 允许读取的根目录，默认内置 fixtures/' },
      outputRoot: { type: 'string', description: '评测 artifact 输出根目录' },
      runId: { type: 'string', description: '可选可复现实验 runId' },
      requiresModule: { type: 'boolean', description: '模块缺失时是否将本 case 标记 skipped' },
    },
    async execute(args) {
      try { return toolResult({ ok: true, artifact: await runEvaluation(args) }) } catch (error) { return errorResult(error) }
    },
  })
  registerTool(ctx.tools, defineTool, {
    name: 'eval_compare',
    title: 'Compare evals',
    description: '显式比较 baseline/candidate artifact；正确率下降、scope leak、secret leak 或 blocking gate 漏放都会失败。',
    parameters: {
      baselineRunId: { type: 'string', required: true },
      candidateRunId: { type: 'string', required: true },
      outputRoot: { type: 'string', description: 'artifact 根目录' },
    },
    async execute(args) {
      try { return toolResult({ ok: true, comparison: await compareEvaluations(args) }) } catch (error) { return errorResult(error) }
    },
  })
  registerTool(ctx.tools, defineTool, {
    name: 'eval_list',
    title: 'List evals',
    description: '显式列出离线评测 artifact 索引。',
    parameters: {
      outputRoot: { type: 'string', description: 'artifact 根目录' },
      limit: { type: 'integer', description: '最多返回条数，默认 100' },
    },
    async execute(args) {
      try { return toolResult({ ok: true, records: await listEvaluations(args) }) } catch (error) { return errorResult(error) }
    },
  })
  if (typeof ctx.provide === 'function') ctx.provide('dshEvals', { runEvaluation, compareEvaluations, listEvaluations, defaults: DEFAULTS })
  return undefined
}

export { compareEvaluations, DEFAULTS, listEvaluations, runEvaluation }

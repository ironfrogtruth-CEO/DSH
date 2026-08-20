/**
 * dsh-intelligence — Host-only task/context contracts.
 *
 * The package deliberately has no client.js and does not subscribe to any
 * conversation, UI, compaction, or agent loop hook.  State changes happen only
 * after one of the explicitly invoked tools below is called.
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { assembleContextBundle, buildContextBundle } from './context-bundle.js'
import { renderError, renderJson } from './render.js'
import { assertValid, JSON_SCHEMAS, validate, validateContinuationCapsule } from './schemas.js'
import { TaskGraph, TaskGraphError, TaskGraphStore } from './task-graph.js'

export const name = 'dsh-intelligence'
export const inject = ['tools']

function resolveRoot() {
  const configured = String(process.env.DSH_INTELLIGENCE_ROOT || '').trim()
  if (configured) return configured
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'intelligence')
}

let toolFactoryPromise

async function resolveDefineTool() {
  if (!toolFactoryPromise) toolFactoryPromise = (async () => {
    try {
      const module = await import('@deepseek-ai/dsh-tools')
      if (typeof module.defineTool === 'function') return module.defineTool
    } catch { /* resolve through the local Harness install below */ }
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    const candidates = [
      join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools'),
      join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools'),
      join(dshHome, 'install', 'node_modules', '@deepseek-ai', 'dsh-tools'),
    ]
    for (const candidate of candidates) {
      try {
        const required = createRequire(join(dshHome, 'dsh-intelligence-runtime.cjs'))(candidate)
        if (typeof required.defineTool === 'function') return required.defineTool
      } catch { /* try the next Harness installation root */ }
    }
    throw new Error('dsh-intelligence requires @deepseek-ai/dsh-tools at Host runtime')
  })()
  return toolFactoryPromise
}

const outputSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    code: { type: 'string' },
    error: { type: 'string' },
  },
}

function toolResultError(error) {
  return {
    ok: false,
    code: error?.code || 'INTELLIGENCE_ERROR',
    error: String(error?.message || error).slice(0, 1_000),
  }
}

function toolResult(tool, value) {
  if (value && typeof value === 'object' && value.ok === false) return value
  return { ok: true, [tool]: value }
}

function createStore() {
  return new TaskGraph({ rootDir: resolveRoot(), backend: process.env.DSH_INTELLIGENCE_BACKEND || 'auto' })
}

function commonTool({ name: toolName, description, parameters, execute, renderTitle }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render: (_args, value) => value?.ok === false ? renderError(value) : renderJson(renderTitle, value),
    },
    timeoutMs: 30_000,
    execute,
    presentCall() { return { card: 'generic', title: renderTitle } },
  }
}

function requireProject(args) {
  if (typeof args?.projectId !== 'string' || !args.projectId.trim()) throw new TaskGraphError('PROJECT_REQUIRED', 'projectId is required; implicit current-project scope is disabled')
  return args.projectId.trim()
}

export async function apply(ctx) {
  const defineTool = await resolveDefineTool()
  const graph = createStore()
  const { tools } = ctx
  const register = (spec) => tools.register(defineTool(spec))

  register(commonTool({
    name: 'intelligence_task_create',
    description: '显式创建一项带 projectId 隔离、验收条件和受保护约束的持久任务。不会自动读取当前会话或改变模型上下文。',
    parameters: {
      task: { type: 'object', additionalProperties: true, required: true, description: 'TaskSpec 草稿；至少包含 projectId、title、objective' },
      nodes: { type: 'array', description: '可选 TaskNode 列表' },
      evidence: { type: 'array', description: '可选 EvidenceRecord 列表' },
    },
    renderTitle: 'Create task',
    async execute(args) {
      try {
        const task = { ...(args.task || {}), projectId: requireProject({ projectId: args.task?.projectId }) }
        return toolResult('task', await graph.create(task, { nodes: args.nodes, evidence: args.evidence }))
      } catch (error) { return toolResultError(error) }
    },
  }))

  register(commonTool({
    name: 'intelligence_task_update',
    description: '显式更新任务状态、节点或证据；expectedRevision 可用于并发 CAS。',
    parameters: {
      taskId: { type: 'string', required: true },
      projectId: { type: 'string', required: true },
      changes: { type: 'object', additionalProperties: true, required: true },
      expectedRevision: { type: 'integer' },
    },
    renderTitle: 'Update task',
    async execute(args) {
      try { return toolResult('task', await graph.update(args.taskId, args.changes, { projectId: requireProject(args), expectedRevision: args.expectedRevision })) } catch (error) { return toolResultError(error) }
    },
  }))

  register(commonTool({
    name: 'intelligence_task_checkpoint',
    description: '显式追加 ContinuationCapsule 检查点；原始事件和旧检查点不会被覆盖。',
    parameters: {
      taskId: { type: 'string', required: true },
      projectId: { type: 'string', required: true },
      capsule: { type: 'object', additionalProperties: true, required: true },
      expectedRevision: { type: 'integer' },
      sessionId: { type: 'string' },
    },
    renderTitle: 'Checkpoint task',
    async execute(args) {
      try { return toolResult('checkpoint', await graph.checkpoint(args.taskId, args.capsule, { projectId: requireProject(args), expectedRevision: args.expectedRevision, sessionId: args.sessionId })) } catch (error) { return toolResultError(error) }
    },
  }))

  register(commonTool({
    name: 'intelligence_task_resume',
    description: '显式从最新任务 projection/检查点恢复；必须给出 projectId 和 sessionId。',
    parameters: {
      taskId: { type: 'string', required: true },
      projectId: { type: 'string', required: true },
      sessionId: { type: 'string', required: true },
      expectedRevision: { type: 'integer' },
    },
    renderTitle: 'Resume task',
    async execute(args) {
      try { return toolResult('resume', await graph.resume(args.taskId, { projectId: requireProject(args), sessionId: args.sessionId, expectedRevision: args.expectedRevision })) } catch (error) { return toolResultError(error) }
    },
  }))

  register(commonTool({
    name: 'intelligence_task_list',
    description: '显式列出一个 projectId 下的任务 projection；跨项目读取会被拒绝。',
    parameters: {
      projectId: { type: 'string', required: true },
      status: { type: 'string' },
      limit: { type: 'integer' },
    },
    renderTitle: 'List tasks',
    async execute(args) {
      try { return toolResult('tasks', await graph.list({ projectId: requireProject(args), status: args.status, limit: args.limit })) } catch (error) { return toolResultError(error) }
    },
  }))

  register(commonTool({
    name: 'intelligence_context_bundle',
    description: '显式把调用者提供的任务、记忆、artifact 和最近事件装配成有预算、有 provenance 的 ContextBundle。默认不会自动注入模型。',
    parameters: {
      request: { type: 'object', additionalProperties: true, required: true, description: 'ContextRequest' },
      sources: { type: 'object', additionalProperties: true, description: '显式提供的 ContextBundle 候选来源' },
    },
    renderTitle: 'Build context bundle',
    async execute(args) {
      try {
        const request = { ...(args.request || {}), projectId: requireProject({ projectId: args.request?.projectId }) }
        return toolResult('bundle', assembleContextBundle(request, args.sources || {}))
      } catch (error) { return toolResultError(error) }
    },
  }))

  register(commonTool({
    name: 'intelligence_contract_validate',
    description: '显式校验一份 Task/Context 合同；只做校验，不写状态、不注入上下文。',
    parameters: {
      schema: { type: 'string', required: true },
      value: { type: 'object', additionalProperties: true, required: true },
    },
    renderTitle: 'Validate contract',
    async execute(args) {
      try {
        const result = validate(args.schema, args.value)
        return { ok: result.ok, schema: args.schema, errors: result.errors }
      } catch (error) { return toolResultError(error) }
    },
  }))

  // Expose the store only to this Host plugin context.  No agent/pre-step
  // hook is installed; callers must invoke a tool explicitly.
  if (typeof ctx.provide === 'function') ctx.provide('dshIntelligence', { graph, schemas: JSON_SCHEMAS, assembleContextBundle, assertValid })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      await graph.close()
    }, 'dsh-intelligence task graph cleanup')
  }
  return undefined
}

export { TaskGraph, TaskGraphStore, assembleContextBundle, buildContextBundle, assertValid, JSON_SCHEMAS, validate, validateContinuationCapsule }
export { createStore }

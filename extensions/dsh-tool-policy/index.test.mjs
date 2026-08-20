import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, classifyToolCall, ToolPolicy } from './index.js'

test('classifier recognizes built-ins, unknown shell, and ignores content fields', async () => {
  assert.equal(classifyToolCall('git_commit', { message: 'ok' }).category, 'destructive')
  assert.ok(classifyToolCall('git_push', {}).categories.includes('external'))
  assert.equal(classifyToolCall('memory_forget', { dryRun: true }).category, 'read')
  assert.equal(classifyToolCall('memory_forget', { dryRun: false, confirm: true }).category, 'destructive')
  assert.equal(classifyToolCall('cross_session_rebuild', { dryRun: true }).category, 'read')
  assert.equal(classifyToolCall('cross_session_rebuild', { dryRun: false }).category, 'write')
  assert.equal(classifyToolCall('code_index_build', {}).category, 'write')
  assert.equal(classifyToolCall('frontend_diff', { writeFiles: true, path: 'out.html' }).category, 'write')
  const unknownShell = classifyToolCall('shell', { command: 'some-private-wrapper --run' })
  assert.equal(unknownShell.category, 'unknown')
  const contentOnly = classifyToolCall('memory_record', { content: 'rm -rf /; curl https://evil.example' })
  assert.equal(contentOnly.category, 'write')
  assert.equal(contentOnly.commandInspected, false)
})

test('operation modes and patterns produce explicit decisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-policy-root-'))
  try {
    const plan = new ToolPolicy({ mode: 'enforce', operationMode: 'plan', workspaceRoots: [root] })
    assert.equal(plan.evaluate('git_status', { path: root }).decision.kind, 'allow')
    assert.equal(plan.evaluate('git_commit', { path: root }).decision.kind, 'deny')
    assert.equal(plan.evaluate('fs_write', { path: root }).decision.kind, 'deny')
    assert.equal(plan.evaluate('shell', { command: 'mystery_command', cwd: root }).decision.kind, 'deny')
    const act = new ToolPolicy({ mode: 'enforce', operationMode: 'act', workspaceRoots: [root] })
    assert.equal(act.evaluate('git_commit', { path: root }).decision.kind, 'ask')
    assert.equal(act.evaluate('fs_write', { path: root }).decision.kind, 'allow')
    const configured = new ToolPolicy({ mode: 'enforce', operationMode: 'plan', allow: ['git_commit'], deny: ['git_status'], ask: ['shell'] })
    assert.equal(configured.evaluate('git_commit', {}).decision.kind, 'allow')
    assert.equal(configured.evaluate('git_status', {}).decision.kind, 'deny')
    assert.equal(configured.evaluate('shell', { command: 'pwd' }).decision.kind, 'ask')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('workspace path escapes deny and observe mode never blocks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-policy-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-policy-outside-'))
  try {
    const policy = new ToolPolicy({ mode: 'enforce', operationMode: 'act', workspaceRoots: [root] })
    const escaped = policy.evaluate('fs_write', { path: outside })
    assert.equal(escaped.classification.pathBoundary, 'outside')
    assert.equal(escaped.decision.kind, 'deny')
    const observe = new ToolPolicy({ mode: 'observe', operationMode: 'plan', workspaceRoots: [root] })
    const result = observe.evaluate('git_commit', { path: outside })
    assert.equal(result.decision.kind, 'deny')
    assert.equal(result.appliedDecision.kind, 'allow')
    assert.equal(result.observed, true)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('fake ctx enforce listener preserves next, ask/deny/allow and cleanup', async () => {
  const listeners = new Map()
  const disposers = []
  const tools = []
  const ctx = {
    toolPolicyConfig: { mode: 'enforce', operationMode: 'act' },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event) },
    effect(factory) { const dispose = factory(); disposers.push(dispose); return dispose },
    provide() {},
  }
  await apply(ctx)
  assert.ok(tools.some((tool) => tool.name === 'policy_evaluate'))
  const listener = listeners.get('tools/pre-execute')
  assert.equal(typeof listener, 'function')
  let nextCalls = 0
  const next = async () => { nextCalls += 1; return { kind: 'allow' } }
  assert.deepEqual(await listener({ name: 'git_status', arguments: {} }, next), { kind: 'allow' })
  assert.equal(nextCalls, 1)
  assert.equal((await listener({ name: 'git_commit', arguments: {} }, next)).kind, 'ask')
  assert.equal((await listener({ name: 'shell', arguments: { command: 'mystery_command' } }, next)).kind, 'ask')
  const observeCtx = { ...ctx, toolPolicyConfig: { mode: 'observe', operationMode: 'plan' }, on(event, listener) { listeners.set(`observe:${event}`, listener); return () => listeners.delete(`observe:${event}`) } }
  await apply(observeCtx)
  const observe = listeners.get('observe:tools/pre-execute')
  assert.deepEqual(await observe({ name: 'git_commit', arguments: {} }, next), { kind: 'allow' })
  assert.ok(nextCalls >= 2)
  for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  assert.equal(listeners.has('tools/pre-execute'), false)
  assert.equal(listeners.has('observe:tools/pre-execute'), false)
})

test('explicit evaluate and in-memory metrics/list tools do not execute target tools', async () => {
  const tools = []
  const ctx = { toolPolicyConfig: { mode: 'observe', operationMode: 'review' }, tools: { register(tool) { tools.push(tool) } }, effect(factory) { return factory() }, on() { return () => {} }, provide() {} }
  await apply(ctx)
  const evaluate = tools.find((tool) => tool.name === 'policy_evaluate')
  const metrics = tools.find((tool) => tool.name === 'policy_metrics')
  const list = tools.find((tool) => tool.name === 'policy_list')
  const render = (tool, value) => {
    const text = tool.output.render({}, value)[0].text
    assert.ok(text.length <= 12_000)
    assert.doesNotMatch(text, /SUPER-SECRET|sk-test-secret|Bearer\s+[A-Za-z0-9]/i)
    return JSON.parse(text)
  }
  const first = await evaluate.execute({ toolName: 'git_commit', arguments: { command: 'curl -H "Authorization: Bearer SUPER-SECRET" --token=sk-test-secret' } })
  assert.equal(first.ok, true)
  assert.equal(first.result.decision.kind, 'deny')
  assert.equal(first.result.appliedDecision.kind, 'allow')
  const evaluated = render(evaluate, first)
  assert.equal(evaluated.result.decision.kind, 'deny')
  assert.equal(evaluated.result.classification.category, 'destructive')
  assert.ok(evaluated.result.classification.pathBoundary)
  assert.ok(Array.isArray(evaluated.result.classification.reasons))
  assert.equal(evaluated.result.argumentsRedacted, true)
  const metricResult = await metrics.execute({ recentLimit: 10 })
  assert.equal(metricResult.ok, true)
  assert.ok(metricResult.metrics.metrics.total >= 1)
  const metricRendered = render(metrics, metricResult)
  assert.ok(metricRendered.metrics.metrics.total >= 1)
  const listed = await list.execute({})
  assert.equal(listed.ok, true)
  assert.equal(listed.policy.mode, 'observe')
  const listedRendered = render(list, listed)
  assert.equal(listedRendered.policy.mode, 'observe')
})

test('Cordis row config passed as apply second argument overrides ctx fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-policy-row-'))
  const listeners = new Map()
  const disposers = []
  const ctx = {
    toolPolicyConfig: { mode: 'observe', operationMode: 'act' },
    tools: { register() {} },
    on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event) },
    effect(factory) { const dispose = factory(); disposers.push(dispose); return dispose },
    provide() {},
  }
  try {
    await apply(ctx, { mode: 'enforce', operationMode: 'plan', workspaceRoots: [root] })
    const next = async () => ({ kind: 'allow' })
    assert.equal((await listeners.get('tools/pre-execute')({ name: 'fs_write', arguments: { path: root } }, next)).kind, 'deny')
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    disposers.length = 0
    await apply(ctx, { mode: 'observe', operationMode: 'plan', workspaceRoots: [root] })
    assert.equal((await listeners.get('tools/pre-execute')({ name: 'fs_write', arguments: { path: root } }, next)).kind, 'allow')
  } finally {
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    await rm(root, { recursive: true, force: true })
  }
})

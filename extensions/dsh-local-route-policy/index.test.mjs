import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOCAL_MODEL_TOOL_NAMES,
  LocalRoutePolicyError,
  REQUIRED_CORE_TOOL_NAMES,
  apply,
  createAssemblyListener,
  filterLocalModelTools,
  filterToolsForProvider,
} from './index.js'

const coreTools = REQUIRED_CORE_TOOL_NAMES.map((name) => ({ name, description: `core ${name}` }))

test('local helper preserves order, keeps core tools, and hides specialist tools', () => {
  const tools = [
    { name: 'browser_open' },
    coreTools[0],
    { name: 'mcp_wechat_publish' },
    ...coreTools.slice(1),
    { name: 'git_push' },
  ]
  const filtered = filterLocalModelTools(tools)
  assert.deepEqual(filtered.map((tool) => tool.name), [
    ...REQUIRED_CORE_TOOL_NAMES,
  ])
  assert.equal(filtered.some((tool) => tool.name === 'browser_open'), false)
  assert.equal(filtered.some((tool) => tool.name === 'mcp_wechat_publish'), false)
  assert.equal(filtered.some((tool) => tool.name === 'git_push'), false)
  assert.equal(filtered.length <= 50, true)
  assert.equal(LOCAL_MODEL_TOOL_NAMES.length <= 50, true)
})

test('missing core tools fail closed instead of returning an incomplete catalog', () => {
  assert.throws(
    () => filterLocalModelTools([{ name: 'bash' }]),
    (error) => error instanceof LocalRoutePolicyError
      && error.code === 'LOCAL_TOOL_POLICY_CORE_MISSING'
      && error.missing.includes('read'),
  )
})

test('route helper returns non-local catalogs unchanged and filters Ollama', () => {
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'skill' }, { name: 'subagent' }, { name: 'execute_flash' }, { name: 'goal_first_state_get' }, { name: 'goal_first_state_transition' }, { name: 'browser_open' }]
  assert.strictEqual(filterToolsForProvider(tools, 'deepseek-official'), tools)
  assert.strictEqual(filterToolsForProvider(tools, 'execute_flash'), tools)
  assert.deepEqual(filterToolsForProvider(tools, 'ollama-local').map((tool) => tool.name), REQUIRED_CORE_TOOL_NAMES)
})

test('waterfall awaits next and filters only the final Ollama assembly', async () => {
  const listener = createAssemblyListener({ requiredNames: ['bash'] })
  let nextCalls = 0
  const final = await listener(
    { variables: { provider: 'deepseek-official' }, tools: [{ name: 'browser_open' }] },
    { agent: { id: 'agent-1' } },
    async () => {
      nextCalls += 1
      return { variables: { provider: 'ollama-local' }, tools: [...coreTools, { name: 'browser_open' }] }
    },
  )
  assert.equal(nextCalls, 1)
  assert.deepEqual(final.tools.map((tool) => tool.name), REQUIRED_CORE_TOOL_NAMES)
})

test('DeepSeek and execute_flash routes keep the complete final catalog', async () => {
  const listener = createAssemblyListener({ requiredNames: ['bash'] })
  for (const provider of ['deepseek-official', 'execute_flash', undefined]) {
    const tools = [{ name: 'bash' }, { name: 'browser_open' }, { name: 'mcp_wechat_publish' }]
    const final = await listener(
      { variables: { provider: 'ollama-local' }, tools: [] },
      {},
      async () => ({ variables: { provider }, tools }),
    )
    assert.strictEqual(final.tools, tools)
  }
})

test('Cordis apply registers the scoped system-prompt waterfall and disposer', async () => {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(factory) {
      const dispose = factory()
      disposers.push(dispose)
      return dispose
    },
  }
  apply(ctx, { requiredNames: ['bash'] })
  assert.equal(typeof listeners.get('system-prompt/assemble'), 'function')
  assert.equal(disposers.length, 1)
  for (const dispose of disposers) dispose?.()
  assert.equal(listeners.has('system-prompt/assemble'), false)
})

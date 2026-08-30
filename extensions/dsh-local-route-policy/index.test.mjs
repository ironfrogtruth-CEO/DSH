import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOCAL_MODEL_TOOL_NAMES,
  LOCAL_MODEL_PERSONA,
  LocalRoutePolicyError,
  REQUIRED_CORE_TOOL_NAMES,
  apply,
  createAssemblyListener,
  filterLocalModelTools,
  filterLocalModelSections,
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
  assert.equal(LOCAL_MODEL_TOOL_NAMES.length <= 30, true)
  assert.equal(LOCAL_MODEL_PERSONA.length <= 2000, true)
})

test('local section filter removes guidance for hidden tools and preserves shared contracts', () => {
  const persona = { name: 'deployment:persona', text: 'persona' }
  const sections = [
    persona,
    { name: 'tool:bash', text: 'bash' },
    { name: 'tool:goal', text: 'goal' },
    { name: 'tool:jobs', text: 'jobs' },
    { name: 'tool:web_search', text: 'web' },
    { name: 'tool:git_commit', text: 'git' },
  ]
  const filtered = filterLocalModelSections(sections)
  assert.notStrictEqual(filtered[0], persona)
  assert.equal(filtered[0].text, LOCAL_MODEL_PERSONA)
  assert.deepEqual(filtered.map((section) => section.name), [
    'deployment:persona',
    'tool:bash',
    'tool:goal',
    'tool:jobs',
  ])
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
  const lightweightShrimpTools = ['policy_list', 'shrimp_list', 'shrimp_match', 'shrimp_knowledge_list', 'shrimp_knowledge_search', 'shrimp_run', 'shrimp_run_status']
  const tools = [
    { name: 'bash' },
    { name: 'read' },
    { name: 'skill' },
    { name: 'subagent' },
    { name: 'execute_flash' },
    { name: 'goal_first_state_get' },
    { name: 'goal_first_state_transition' },
    ...lightweightShrimpTools.map((name) => ({ name })),
    { name: 'browser_open' },
    { name: 'mcp_wechat_publish' },
  ]
  assert.strictEqual(filterToolsForProvider(tools, 'deepseek-official'), tools)
  assert.strictEqual(filterToolsForProvider(tools, 'execute_flash'), tools)
  assert.deepEqual(filterToolsForProvider(tools, 'ollama-local').map((tool) => tool.name), [
    ...REQUIRED_CORE_TOOL_NAMES,
    ...lightweightShrimpTools,
  ])
  assert.equal(filterToolsForProvider(tools, 'ollama-local').some((tool) => tool.name === 'browser_open'), false)
  assert.equal(filterToolsForProvider(tools, 'ollama-local').some((tool) => tool.name === 'mcp_wechat_publish'), false)
})

test('waterfall awaits next and filters only the final Ollama assembly', async () => {
  const listener = createAssemblyListener({ requiredNames: ['bash'] })
  let nextCalls = 0
  const final = await listener(
    { variables: { provider: 'deepseek-official' }, tools: [{ name: 'browser_open' }] },
    { agent: { id: 'agent-1' } },
    async () => {
      nextCalls += 1
      return { variables: { provider: 'ollama-local' }, sections: [], tools: [...coreTools, { name: 'browser_open' }] }
    },
  )
  assert.equal(nextCalls, 1)
  assert.deepEqual(final.tools.map((tool) => tool.name), REQUIRED_CORE_TOOL_NAMES)
})

test('DeepSeek and execute_flash routes keep the complete final catalog', async () => {
  const listener = createAssemblyListener({ requiredNames: ['bash'] })
  for (const provider of ['deepseek-official', 'execute_flash', undefined]) {
    const tools = [{ name: 'bash' }, { name: 'browser_open' }, { name: 'mcp_wechat_publish' }]
    const assembly = { variables: { provider }, sections: [{ name: 'cloud:full', text: 'unchanged' }], contexts: [{ name: 'runtime', text: 'unchanged' }], tools }
    const final = await listener(
      { variables: { provider: 'ollama-local' }, tools: [] },
      {},
      async () => assembly,
    )
    assert.strictEqual(final, assembly)
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

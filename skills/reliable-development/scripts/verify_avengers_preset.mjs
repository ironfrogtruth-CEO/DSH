#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const configuredHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const root = resolve(process.argv[2] || join(configuredHome, '.agent-presets', 'avengers'))
const dshHome = process.argv[2] ? dirname(dirname(root)) : resolve(configuredHome)
const cyberRoot = join(dshHome, '.agent-presets', 'reliable-development')

const [composition, metadata, cyberComposition] = await Promise.all([
  readFile(join(root, 'agent.cordis.yml'), 'utf8'),
  readFile(join(root, 'preset.yml'), 'utf8'),
  readFile(join(cyberRoot, 'agent.cordis.yml'), 'utf8'),
])

const yaml = createRequire(join(dshHome, 'install', 'package.json'))('yaml')
const parsedComposition = yaml.parse(composition.replaceAll('!!js ', ''))
const parsedMetadata = yaml.parse(metadata)

function walkRows(rows, path = []) {
  const result = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue
    result.push({ row, path })
    if (Array.isArray(row.config)) result.push(...walkRows(row.config, [...path, row.id || '<group>']))
  }
  return result
}

const rows = walkRows(parsedComposition)
const rowById = (id) => rows.filter(({ row }) => row.id === id).map(({ row }) => row)
const delegationRows = rows
  .map(({ row }) => row)
  .filter((row) => row.name === '@deepseek-ai/dsh-tool-subagent' && row.config?.toolName)

assert.equal(parsedMetadata?.name, 'Avengers', 'preset.yml must display Avengers')
assert.match(metadata, /^name:\s*Avengers\s*$/m)
assert.match(composition, /You are Avengers, the direct-delegation CyberMarcus mode/)

// The Avengers composition must retain the common CyberMarcus governance core.
// The comparison is deliberately anchor-based so unrelated capability rows can
// evolve in the source preset without creating a second copy of its registry.
const governanceAnchors = [
  'goal-first-control',
  'sop-orchestrator',
  'output_contract',
  'Failure Recovery Gate',
  'memory_recall',
  'memory_checkpoint',
  'run_in_background',
  '生产蓝图合同',
  'evidence-first-recovery.md',
  'QA',
  'rollback',
]
for (const anchor of governanceAnchors) {
  assert.ok(cyberComposition.includes(anchor), `CyberMarcus governance anchor missing: ${anchor}`)
  assert.ok(composition.includes(anchor), `Avengers governance anchor missing: ${anchor}`)
}

for (const id of [
  'persona',
  'agent-instructions',
  'filesystem',
  'tool-bash',
  'tool-fs',
  'tool-fs-search',
  'tool-jobs',
  'skill-filesystem',
  'tool-skill',
  'tool-goal',
  'time-context',
  'planning',
  'compaction',
  'tool-ask-user',
  'tool-todo',
  'tool-web',
]) {
  assert.equal(rowById(id).length, 1, `Avengers must retain shared CyberMarcus row ${id}`)
}

// There is exactly one model-facing execution route, and it is the
// continuable spawn-backed avenger tool.
assert.equal(delegationRows.length, 1, 'Avengers must expose exactly one delegation tool')
const avengerRow = delegationRows[0]
assert.equal(avengerRow.id, 'tool-subagent-avenger')
assert.equal(avengerRow.config.provider, 'spawn')
assert.equal(avengerRow.config.toolName, 'avenger')
assert.equal(avengerRow.config.backgroundMode, 'continuable')
assert.equal(avengerRow.config.enableRunInBackground, true)
assert.equal(avengerRow.config.maxDepth, 1)
assert.deepEqual(avengerRow.config.agentOptions, {
  provider: 'zhipu-glm',
  model: 'glm-5.3-flash',
  maxTokens: 32768,
})
assert.deepEqual(avengerRow.config.toolFilter?.deny, ['avenger'])
assert.equal(rows.filter(({ row }) => row.config?.toolName).length, 1, 'no alternate toolName route may be callable')
assert.doesNotMatch(composition, /@deepseek-ai\/dsh-tool-workflow/)
assert.doesNotMatch(composition, /@deepseek-ai\/dsh-tool-ralph/)
assert.doesNotMatch(composition, /toolName:\s*(?:subagent|subagent_fork|subagent_flash|execute_flash|workflow|ralph)\b/)
assert.equal(
  rows.filter(({ row }) => /workflow|ralph/i.test(`${row.id || ''} ${row.name || ''}`)).length,
  0,
  'workflow and ralph must not be callable rows',
)

// Direct-dispatch and model contracts belong in both the parent persona and
// the child persona so a later prompt compaction cannot silently erase them.
assert.match(composition, /every user task,[\s\S]*must be assigned[\s\S]*before execution/i)
assert.match(composition, /The parent does not carry out the task itself/i)
assert.match(composition, /Before every avenger call,[\s\S]*exact full Marvel hero or antihero call sign/i)
assert.match(composition, /parent route defaults to DeepSeek V4 Pro with High reasoning/i)
assert.match(composition, /avenger child route is fixed to zhipu-glm\/glm-5\.3-flash with Medium reasoning/i)
assert.match(composition, /Medium contract is enforced by Host route selection/i)
assert.match(composition, /蜘蛛侠·检索-01/)
assert.match(composition, /黑豹·结构-02/)
assert.match(composition, /灭霸·执行-03/)
assert.match(composition, /洛基·审计-04/)
assert.match(composition, /死侍·修复-05/)
assert.match(composition, /毒液·QA-06/)
assert.match(composition, /examples are not a whitelist/i)
assert.match(composition, /stable <Marvel角色>·<职能>-<两位序号>/)

const childPersona = String(avengerRow.config.persona || '')
assert.match(childPersona, /Marvel hero or antihero call sign/)
assert.match(childPersona, /exclusive files\/modules or responsibility boundary/)
assert.match(childPersona, /objective, inputs, constraints, focused validation, and acceptance criteria/)
assert.match(childPersona, /洛基.*死侍.*毒液.*灭霸/s)
assert.match(childPersona, /zhipu-glm\/glm-5\.3-flash at Medium reasoning/)
assert.match(childPersona, /never call avenger/)

// Isolation checks: the existing CyberMarcus preset remains its own identity
// and does not gain the Avengers-only route as a side effect.
assert.match(cyberComposition, /You are CyberMarcus, the Reliable Development Agent/)
assert.doesNotMatch(cyberComposition, /toolName:\s*avenger\b/)
assert.doesNotMatch(cyberComposition, /id:\s*tool-subagent-avenger\b/)
assert.match(cyberComposition, /toolName:\s*subagent_flash\b/)

async function rpc(baseUrl, method, payload) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `verify-${randomUUID()}`, method, payload }),
  })
  assert.equal(response.ok, true, `${method} transport failed: HTTP ${response.status}`)
  const body = await response.json()
  assert.equal(body.result?.ok, true, `${method} failed: ${JSON.stringify(body.result?.error || body)}`)
  return body.result.value
}

async function runMountCheck(baseUrl) {
  const sessionId = `preset-mount-check-avengers-${Date.now()}-${randomUUID()}`
  const cwd = join(tmpdir(), 'dsh-avengers-mount-check')
  const created = await rpc(baseUrl, 'session.create', { sessionId, cwd, agentPreset: 'avengers' })
  assert.equal(created.sessionId, sessionId)
  assert.equal(created.agentPreset, 'avengers')
  await rpc(baseUrl, 'workspace.archiveSession', { sessionId })
  console.log(`Avengers preset: real mount OK (${sessionId}; no model request)`)
}

if (process.env.DSH_MOUNT_TEST_URL) await runMountCheck(process.env.DSH_MOUNT_TEST_URL)
console.log('Avengers preset: OK')

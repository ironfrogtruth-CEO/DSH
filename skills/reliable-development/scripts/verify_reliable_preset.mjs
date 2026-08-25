#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const configuredHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const root = resolve(process.argv[2] || join(configuredHome, '.agent-presets', 'reliable-development'))
const dshHome = process.argv[2] ? dirname(dirname(root)) : resolve(configuredHome)
const composition = await readFile(join(root, 'agent.cordis.yml'), 'utf8')
const metadata = await readFile(join(root, 'preset.yml'), 'utf8')
const goalRoot = join(dshHome, 'skills', 'goal-first-control')
const goalSkill = await readFile(join(goalRoot, 'SKILL.md'), 'utf8')
const goalUi = await readFile(join(goalRoot, 'agents', 'openai.yaml'), 'utf8')
const enterpriseOrchestrator = await readFile(join(dshHome, 'skills', 'enterprise-health-orchestrator', 'SKILL.md'), 'utf8')

for (const required of [
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
  '@local/dsh-compaction-v2',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-workflow',
]) assert.ok(composition.includes(required), `missing ${required}`)

assert.match(composition, /model:\s*deepseek-v4-flash[\s\S]*retainTokens:\s*120000/)
assert.match(composition, /model:\s*deepseek-v4-pro[\s\S]*retainTokens:\s*120000/)
assert.match(composition, /model:\s*gemma4:26b-a4b-it-qat[\s\S]*retainTokens:\s*32768/)
assert.match(composition, /isolate:[\s\S]*compaction:\s*true[\s\S]*toolResultPruner:\s*true[\s\S]*dshCompactionV2:\s*true/)
assert.match(composition, /memory_recall/)
assert.match(composition, /memory_checkpoint/)
assert.match(composition, /toolName:\s*execute_flash/)
assert.match(composition, /model:\s*deepseek-v4-flash/)
assert.match(composition, /maxDepth:\s*1/)
assert.match(composition, /deny:[\s\S]*execute_flash[\s\S]*workflow/)
assert.match(composition, /Before every delegation, tell the user/)
assert.match(composition, /Start the final report with that exact name/)
assert.match(composition, /Load goal-first-control before planning/)
assert.match(composition, /real problem, audience\/action, deliverables, truth sources, constraints, success criteria/)
assert.match(composition, /classifies the task as `sop_required`, load sop-orchestrator/)
assert.match(composition, /load native-chinese-expression/)
assert.match(composition, /## Explicit Output Contract Gate/)
assert.match(composition, /return exactly one sentence with no heading, preface, explanation, alternatives, bullets, or trailing note/)
assert.match(goalSkill, /simple_direct/)
assert.match(goalSkill, /sop_required/)
assert.match(goalSkill, /goal_contract/)
assert.match(goalSkill, /output_contract/)
assert.match(goalSkill, /完成证据 <- 验证 <- 最终产物 <- 生成 <- 结构 <- 真源 <- 路由/)
assert.match(goalSkill, /enterprise-health-orchestrator/)
assert.doesNotMatch(goalSkill, /Use for A00 orchestration only/)
assert.match(goalUi, /display_name:\s*"以终为始"/)
assert.match(goalUi, /\$goal-first-control/)
assert.match(enterpriseOrchestrator, /A00.*A01.*A11/)
assert.match(metadata, /name:\s*可靠开发模式/)
console.log('reliable-development preset: OK')

const localRoot = join(dshHome, '.agent-presets', 'reliable-local')
const localComposition = await readFile(join(localRoot, 'agent.cordis.yml'), 'utf8')
const localMetadata = await readFile(join(localRoot, 'preset.yml'), 'utf8')
for (const required of ['@deepseek-ai/dsh-tool-bash-persistent', '@deepseek-ai/dsh-tool-str-replace-editor', '@deepseek-ai/dsh-compaction-basic']) {
  assert.ok(localComposition.includes(required), `local preset missing ${required}`)
}
assert.match(localComposition, /includeRuntimeContext:\s*false/)
assert.match(localComposition, /retainTokens:\s*32768/)
assert.match(localMetadata, /name:\s*可靠本地开发模式/)
console.log('reliable-local preset: OK')

#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const configuredHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const root = resolve(process.argv[2] || join(configuredHome, '.agent-presets', 'reliable-development'))
const dshHome = process.argv[2] ? dirname(dirname(root)) : resolve(configuredHome)
const composition = await readFile(join(root, 'agent.cordis.yml'), 'utf8')
const metadata = await readFile(join(root, 'preset.yml'), 'utf8')
const skillRoot = join(dshHome, 'skills', 'reliable-development')
const skill = await readFile(join(skillRoot, 'SKILL.md'), 'utf8')
const recovery = await readFile(join(skillRoot, 'references', 'evidence-first-recovery.md'), 'utf8')
const checkpoint = await readFile(join(skillRoot, 'references', 'checkpoint-schema.md'), 'utf8')
const goalRoot = join(dshHome, 'skills', 'goal-first-control')
const goalSkill = await readFile(join(goalRoot, 'SKILL.md'), 'utf8')
const systemAgents = await readFile(join(dshHome, 'AGENTS.md'), 'utf8')
const goalUi = await readFile(join(goalRoot, 'agents', 'openai.yaml'), 'utf8')
const enterpriseOrchestrator = await readFile(join(dshHome, 'skills', 'enterprise-health-orchestrator', 'SKILL.md'), 'utf8')
const modelCalibration = await readFile(join(skillRoot, 'references', 'model-calibration.md'), 'utf8')
const subagentOrchestration = await readFile(join(skillRoot, 'references', 'subagent-orchestration.md'), 'utf8')
const architecture = await readFile(join(dshHome, 'architecture', 'current-system.md'), 'utf8')
const webCordisPatch = await readFile(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
const webProfile = JSON.parse(await readFile(join(dshHome, 'profiles', 'web', 'package.json'), 'utf8'))
const webBundles = new Set(webProfile.dsh?.profile?.bundles || [])
const yaml = createRequire(join(dshHome, 'install', 'package.json'))('yaml')
const parsedComposition = yaml.parse(composition.replaceAll('!!js ', ''))
const settings = yaml.parse(await readFile(join(dshHome, 'settings.yaml'), 'utf8'))
const containerManifest = yaml.parse(await readFile(join(dshHome, 'container.manifest.yaml'), 'utf8'))
const ollamaProfile = settings?.['llm-pi-ai']?.providers?.['ollama-local']
const pickerModels = Array.isArray(ollamaProfile?.models) ? ollamaProfile.models : []

function expressionDisabled(value) {
  if (value === true) return true
  if (typeof value !== 'string') return false
  if (value.includes('process.platform ===') && value.includes('win32')) return process.platform === 'win32'
  if (value.includes('process.platform !==') && value.includes('win32')) return process.platform !== 'win32'
  return false
}

function activeRows(rows, inheritedDisabled = false, path = []) {
  const result = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue
    const disabled = inheritedDisabled || expressionDisabled(row.disabled)
    if (!disabled && typeof row.name === 'string') result.push({ id: row.id, name: row.name, path })
    if (Array.isArray(row.config)) result.push(...activeRows(row.config, disabled, [...path, row.id || '<group>']))
  }
  return result
}

const activeCompositionRows = activeRows(parsedComposition)
const activeOrdinaryBash = activeCompositionRows.filter((row) => row.name === '@deepseek-ai/dsh-tool-bash')
const activePersistentBash = activeCompositionRows.filter((row) => row.name === '@deepseek-ai/dsh-tool-bash-persistent')
const activePwsh = activeCompositionRows.filter((row) => row.name === '@deepseek-ai/dsh-tool-pwsh')
const activeJobs = activeCompositionRows.filter((row) => row.name === '@deepseek-ai/dsh-tool-jobs')
assert.equal(activeJobs.length, 1, 'preset must expose exactly one tool-jobs controller')
if (process.platform === 'win32') {
  assert.equal(activePersistentBash.length, 0, 'Windows must disable persistent-shell')
  assert.equal(activeOrdinaryBash.length, 0, 'Windows must not activate ordinary bash')
  assert.equal(activePwsh.length, 1, 'Windows must retain exactly one pwsh provider')
} else {
  assert.equal(activePersistentBash.length, 0, 'Mac/Linux must not activate the legacy persistent bash provider')
  assert.equal(activeOrdinaryBash.length, 1, 'Mac/Linux must activate exactly one standard tool-bash provider')
  assert.equal(activePwsh.length, 0, 'Mac/Linux must not activate pwsh')
}

assert.equal((composition.match(/name:\s*'@deepseek-ai\/dsh-tool-bash'/g) || []).length, 1, 'composition must register one standard bash row')
assert.equal((composition.match(/name:\s*'@deepseek-ai\/dsh-tool-bash-persistent'/g) || []).length, 0, 'composition must not register the legacy persistent bash row')
assert.match(composition, /- id: tool-bash[\s\S]*?name:\s*'@deepseek-ai\/dsh-tool-bash'[\s\S]*?enableRunInBackground:\s*true/)
assert.doesNotMatch(composition, /persistent_bash|persistent bash|persistent-shell|tool-bash-persistent/i)
const standardBashRow = parsedComposition.find((row) => row?.id === 'tool-bash')
assert.equal(standardBashRow?.config?.enableRunInBackground, true, 'standard bash must explicitly enable run_in_background')

for (const required of [
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-time-context',
  '@local/dsh-compaction-v2',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-workflow',
]) assert.ok(composition.includes(required), `missing ${required}`)

assert.match(composition, /model:\s*deepseek-v4-flash[\s\S]*retainTokens:\s*120000/)
assert.match(composition, /model:\s*deepseek-v4-pro[\s\S]*retainTokens:\s*120000/)
assert.doesNotMatch(composition, /provider:\s*ollama-local|model:\s*(?:cybermarcus(?:-codex)?:latest|glm-marcus:latest|gemma4:26b-a4b-it-qat)/)
assert.match(composition, /isolate:[\s\S]*compaction:\s*true[\s\S]*toolResultPruner:\s*true[\s\S]*dshCompactionV2:\s*true/)
assert.match(composition, /\{\{provider\}\}\/\{\{model\}\}/)
assert.match(composition, /provider.*deepseek-official|configured cloud DeepSeek\/智谱 route/i)
assert.match(composition, /run_in_background/)
assert.match(composition, /enableRunInBackground:\s*true/)
assert.match(composition, /dsh-tool-str-replace-editor/)

for (const contract of [composition, skill]) {
  assert.match(contract, /run_in_background:\s*true|run_in_background`\s*[:：]?\s*true/)
  assert.match(contract, /job id/i)
  assert.match(contract, /nohup/)
  assert.match(contract, /disown/)
  assert.match(contract, /setsid/)
  assert.match(contract, /bare trailing `&`|尾随 `&`|trailing `&`/i)
  assert.match(contract, /session schedule|heartbeat runner|canonical ShrimpTank SQLite run/i)
  assert.match(contract, /process-local job.*(?:not|不).*(?:durable|持久|跨重启)/is)
}
assert.doesNotMatch(skill, /persistent_bash|persistent bash|persistent-shell|tool-bash-persistent/i)
assert.match(webCordisPatch, /name:\s*["']@local\/dsh-tool-policy["'][\s\S]*?blockDetachedBackground:\s*true/)
assert.equal(ollamaProfile, undefined, 'retired local conversation provider must not remain selectable')
assert.deepEqual(pickerModels, [], 'local conversation picker must be empty')
const agentDefaultModel = settings?.['agent-default-model']
assert.ok(agentDefaultModel, 'settings must declare agent-default-model')
const knownProviders = new Set(['deepseek-official', ...Object.keys(settings?.['llm-pi-ai']?.providers ?? {})])
assert.ok(knownProviders.has(agentDefaultModel.provider), `agent-default-model provider ${agentDefaultModel.provider} must be a known provider`)
const modelPrefix = String(agentDefaultModel.model ?? '').split(/[-:.]/, 1)[0].toLowerCase()
assert.ok(modelPrefix.length > 0 && String(agentDefaultModel.provider).toLowerCase().includes(modelPrefix), `agent-default-model model ${agentDefaultModel.model} prefix must match provider ${agentDefaultModel.provider}`)
assert.ok(['off', 'low', 'medium', 'high', 'max'].includes(agentDefaultModel.reasoningEffort), `agent-default-model reasoningEffort ${agentDefaultModel.reasoningEffort} must be a supported effort`)
const pickerIds = new Set(pickerModels.map((model) => model.id))
for (const hiddenModel of ['cybermarcus:latest', 'glm-marcus:latest', 'gemma4:26b-a4b-it-qat', 'x/flux2-klein:4b', 'embeddinggemma:latest']) {
  assert.equal(pickerIds.has(hiddenModel), false, `${hiddenModel} must remain backend-only`)
}
assert.equal(pickerModels.some((model) => /tts|stt|voice|speech|语音/i.test(`${model.id} ${model.name || ''}`)), false, 'TTS/STT must not enter the LLM picker')
assert.deepEqual(
  containerManifest?.dependencies?.ollama?.models,
  ['x/flux2-klein:4b', 'embeddinggemma:latest'],
  'container must retain only the local image and retrieval models',
)
assert.doesNotMatch(composition, /@deepseek-ai\/dsh-tool-cordis/)
assert.match(composition, /cordis.*Host singleton|Host singleton.*Cordis/i)
assert.match(composition, /doctor.*profile.*architecture/i)
assert.doesNotMatch(composition, /complete:\s*true/)
assert.doesNotMatch(composition, /includeRuntimeContext:\s*false/)
assert.match(composition, /memory_recall/)
assert.match(composition, /memory_checkpoint/)
assert.match(composition, /toolName:\s*execute_flash/)
assert.match(composition, /toolName:\s*subagent_flash/)
assert.match(composition, /model:\s*deepseek-v4-flash/)
assert.match(composition, /maxDepth:\s*1/)
assert.match(composition, /deny:[\s\S]*execute_flash[\s\S]*workflow/)
for (const bundle of [
  '@local/dsh-browser',
  '@local/dsh-dsbalance',
  '@local/dsh-git',
  '@local/dsh-memory',
  '@local/dsh-screen',
  '@local/dsh-shrimp-shell',
  '@local/zhipu-media',
  '@local/dsh-tool-policy',
  '@local/dsh-intelligence',
  '@local/dsh-code-intelligence',
  '@local/dsh-cross-session',
  '@local/dsh-frontend-qa',
  '@local/dsh-goal-first-state-machine',
  '@local/dsh-evals',
  '@local/dsh-compaction-v2',
  'deepseek-idesign',
  'deepseek-ippt',
]) assert.ok(webBundles.has(bundle), `web profile missing Host bundle ${bundle}`)
assert.match(composition, /Before every delegation, tell the user/)
assert.match(composition, /Start the final report with that exact name/)
for (const hero of ['蜘蛛侠·前端-01', '黑豹·后端-01', '黑寡妇·QA-01', '奇异博士·研究-01', '鹰眼·审计-01', '雷神·执行-01']) {
  assert.match(composition, new RegExp(hero))
}
assert.match(composition, /exclusive owned files|exclusive file|exclusive.*files|独占.*文件|exclusive.*module/i)
assert.match(composition, /examples are not a whitelist|not a whitelist/i)
assert.match(composition, /钢铁侠.*美国队长.*惊奇队长.*火箭浣熊/s)
assert.match(composition, /description.*begin.*exact full call sign|exact full call sign.*description/is)
assert.match(composition, /list_agents.*send_message.*report/s)
assert.match(composition, /Never set `run_in_background: false`|Never set `run_in_background`.*false/s)
assert.match(subagentOrchestration, /subagent_flash/)
assert.match(subagentOrchestration, /dynamic, not limited to a fixed shortlist/i)
assert.match(subagentOrchestration, /Parent → child:[\s\S]*Child → parent:/)
assert.match(composition, /Apply the adaptive three-axis judgment before planning/)
assert.match(systemAgents, /目标、受众动作、交付物.*完成标准/s)
assert.match(composition, /load sop-orchestrator only if it classifies the task as `sop_required`|classifies the task as `sop_required` or the model activates formal planning/)
assert.match(composition, /Adaptive three-axis compatibility/)
assert.match(composition, /action=activate_formal/)
assert.match(composition, /axisDepths\.planBeforeAction=full/)
assert.match(composition, /ordinary tasks remain `simple_direct`\/adaptive/i)
assert.match(composition, /execution ownership/i)
assert.doesNotMatch(composition, /answer directly/i)
assert.match(systemAgents, /三板斧/)
assert.match(systemAgents, /implicit.*light.*full/s)
assert.match(systemAgents, /action=activate_formal/)
assert.match(systemAgents, /structure.*workContract.*structureContract/s)
assert.match(systemAgents, /simple_direct.*不进入正式七节点.*执行所有权/s)
assert.match(composition, /load native-chinese-expression/)
assert.match(composition, /## Explicit Output Contract Gate/)
assert.match(composition, /return exactly one sentence with no heading, preface, explanation, alternatives, bullets, or trailing note/)
assert.match(composition, /## Failure Recovery Gate/)
assert.match(composition, /change_since_last_attempt/)
assert.match(composition, /monotonic terminal states/)
assert.match(composition, /A real production run is final integration evidence/)
assert.match(skill, /references\/evidence-first-recovery\.md/)
assert.match(skill, /stable failure fingerprint/)
assert.match(recovery, /QA_PROTOCOL_FAILED/)
assert.match(recovery, /QUALITY_GATE_FAILED/)
assert.match(recovery, /failure_fingerprint/)
assert.match(recovery, /lease heartbeat plus fencing\/claim generation/)
assert.match(checkpoint, /Failure class and fingerprint/)
assert.match(checkpoint, /Change since last attempt and expected observation/)
assert.match(checkpoint, /parent_run_id/)
assert.match(checkpoint, /claim_generation/)
assert.match(checkpoint, /Goal contract and success criteria/)
assert.match(checkpoint, /Current pipeline node and confirmed upstream/)
assert.match(goalSkill, /simple_direct/)
assert.match(goalSkill, /sop_required/)
assert.match(goalSkill, /axis.*implicit.*light.*full/is)
assert.match(goalSkill, /activate_formal/)
assert.match(goalSkill, /goal_contract/)
assert.match(goalSkill, /output_contract/)
assert.match(goalSkill, /完成证据 <- 验证 <- 最终产物 <- 生成 <- 结构 <- 真源 <- 路由/)
assert.match(goalSkill, /enterprise-health-orchestrator/)
assert.doesNotMatch(goalSkill, /Use for A00 orchestration only/)
assert.match(goalUi, /display_name:\s*"以终为始"/)
assert.match(goalUi, /\$goal-first-control/)
assert.match(enterpriseOrchestrator, /A00.*A01.*A11/)
assert.match(metadata, /name:\s*CyberMarcus/)
assert.doesNotMatch(modelCalibration, /cybermarcus(?::|-codex)|glm-marcus|gemma4/i)
assert.match(modelCalibration, /cloud DeepSeek.*智谱|智谱.*cloud DeepSeek/i)
assert.match(modelCalibration, /x\/flux2-klein.*backend image route|backend image route.*x\/flux2-klein/i)
assert.match(modelCalibration, /embeddinggemma.*backend retrieval|backend retrieval.*embeddinggemma/i)
assert.match(modelCalibration, /dsh-local-ai.*tts.*stt|tts.*stt.*dsh-local-ai/i)
assert.match(modelCalibration, /audio\/transcription.*video|video.*audio\/transcription/i)
assert.match(skill, /FLUX image generation.*audio\/transcription.*video\/成片|audio\/transcription.*video\/成片.*FLUX image generation/i)
assert.match(skill, /top-level.*(?:dispatch|worker)|(?:dispatch|worker).*top-level/i)
assert.match(skill, /large schemas are hidden|hidden from the compact local prompt/i)
assert.doesNotMatch(skill, /cybermarcus(?::|-codex)|glm-marcus|gemma4|ollama-local/i)
assert.match(architecture, /canonical.*本地模型根.*\/Users\/marcus\/Desktop\/虾缸\/MODEL|\/Users\/marcus\/Desktop\/虾缸\/MODEL.*canonical/i)
assert.match(subagentOrchestration, /蜘蛛侠·前端-01/)
assert.match(subagentOrchestration, /exclusive file\/module|exclusive.*ownership|独占.*文件/i)

async function runMountCheck(baseUrl) {
  const sessionId = `preset-mount-check-${Date.now()}-${randomUUID()}`
  const cwd = join(tmpdir(), 'dsh-cybermarcus-mount-check')
  async function rpc(method, payload) {
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
  const created = await rpc('session.create', { sessionId, cwd, agentPreset: 'reliable-development' })
  assert.equal(created.sessionId, sessionId)
  assert.equal(created.agentPreset, 'reliable-development')
  await rpc('workspace.archiveSession', { sessionId })
  console.log(`reliable-development preset: real mount OK (${sessionId}; no model request)`)
}

if (process.env.DSH_MOUNT_TEST_URL) await runMountCheck(process.env.DSH_MOUNT_TEST_URL)
console.log('reliable-development preset: OK')

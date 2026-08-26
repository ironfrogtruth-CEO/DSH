#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const presetRoot = dirname(fileURLToPath(import.meta.url))
const dshHome = resolve(process.env.DSH_HOME || join(presetRoot, '..', '..'))
const requireFromInstall = createRequire(join(dshHome, 'install', 'package.json'))

let yaml
try {
  yaml = requireFromInstall('yaml')
} catch (error) {
  throw new Error(`cannot resolve YAML parser from ${dshHome}/install: ${error.message}`)
}

const compositionText = await readFile(join(presetRoot, 'agent.cordis.yml'), 'utf8')
const metadataText = await readFile(join(presetRoot, 'preset.yml'), 'utf8')
const document = yaml.parseDocument(compositionText, { prettyErrors: true })

assert.equal(document.errors.length, 0, `agent.cordis.yml YAML errors: ${document.errors.map((error) => error.message).join('; ')}`)
assert.ok(Array.isArray(document.toJSON()), 'agent.cordis.yml must parse to a top-level list')
assert.match(metadataText, /^name:\s*可靠本地开发模式\s*$/m)

const composition = document.toJSON()
const ids = new Set(composition.map((entry) => entry?.id).filter(Boolean))
for (const id of ['persona', 'tool-bash', 'tool-jobs', 'filesystem', 'skill-filesystem', 'tool-skill', 'compaction']) {
  assert.ok(ids.has(id), `missing top-level preset entry: ${id}`)
}

for (const required of [
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
]) {
  assert.ok(compositionText.includes(required), `missing local service: ${required}`)
}

for (const required of [
  'load goal-first-control before planning',
  'only when it is `sop_required`, load sop-orchestrator',
  'load native-chinese-expression',
  'Explicit Output Contract Gate',
  'requested quantity, format, length limit, language',
  'self-correct exactly once',
  'exactly one sentence',
  'no heading, preface, explanation, alternatives, options, bullets',
]) {
  assert.ok(compositionText.includes(required), `missing contract rule: ${required}`)
}

assert.match(compositionText, /includeRuntimeContext:\s*false/)
assert.match(compositionText, /enableRunInBackground:\s*true/)
assert.match(compositionText, /run_in_background:\s*true/)
assert.match(compositionText, /job_output\/job_list\/job_kill/)
assert.match(compositionText, /nohup.*disown.*setsid.*trailing ampersand/s)
assert.match(compositionText, /process-local job does not survive Host restart/)
assert.doesNotMatch(compositionText, /persistent_bash|tool-bash-persistent|persistent-shell/i)
assert.match(compositionText, /thresholdRatio:\s*0\.60/)
assert.match(compositionText, /retainTokens:\s*32768/)
assert.match(compositionText, /compactionRetries:\s*2/)
assert.match(compositionText, /maxOverflowRetries:\s*2/)
assert.match(compositionText, /auto:\s*true/)

console.log('reliable-local preset: YAML, structure, routing, output gate, and local-model safeguards OK')

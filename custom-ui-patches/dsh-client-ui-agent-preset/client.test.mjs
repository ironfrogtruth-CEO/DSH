import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('./', import.meta.url)
const originalUrl = new URL('./client.js.original', root)
const patchUrl = new URL('./client.js.modified', root)
const installedUrl = new URL('../../install/node_modules/@deepseek-ai/dsh-client-ui-agent-preset/lib/client.js', root)

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle)
  assert.notEqual(start, -1, `missing source section: ${startNeedle}`)
  const end = source.indexOf(endNeedle, start)
  assert.notEqual(end, -1, `missing source section end: ${endNeedle}`)
  return source.slice(start, end)
}

test('picker and settings preserve the complete Host roster and add Avengers without hiding built-ins', async () => {
  const [patched, installed] = await Promise.all([
    readFile(patchUrl, 'utf8'),
    readFile(installedUrl, 'utf8'),
  ])

  assert.equal(installed, patched, 'live bundle must be the reviewed modified bundle')

  const helperSource = section(
    patched,
    'function visiblePresetRoster(presets) {',
    '\n\t\tconst INITIAL$2',
  )
  const helpers = Function(`${helperSource}; return { visiblePresetRoster, presetOptions }`)()
  const roster = [
    { id: 'standard', trust: 'system' },
    { id: 'reliable-development', trust: 'user', isDefault: true },
    { id: 'avengers', trust: 'user' },
    { id: 'broken-custom', trust: 'user', broken: { message: 'fixture' } },
    { id: 'cordis', trust: 'system' },
  ]

  assert.deepEqual(
    helpers.visiblePresetRoster(roster).map((preset) => preset.id),
    ['standard', 'reliable-development', 'avengers', 'broken-custom', 'cordis'],
  )
  assert.deepEqual(
    helpers.presetOptions(roster).map((preset) => preset.id),
    ['standard', 'reliable-development', 'avengers', 'cordis'],
  )
  assert.match(patched, /const visiblePresets = visiblePresetRoster\(presets\);\n\s*const \[first\] = visiblePresets/)
  assert.match(patched, /currentValue: visiblePresets\.find\(\(preset\) => preset\.isDefault\)\?\.id \?\? first\.id/)
  assert.match(patched, /rows: visiblePresets\.map\(\(preset\) => \(\{ \.\.\.preset \}\)\)/)
})

test('historical reliable-local session labels display CyberMarcus while unknown ids remain recoverable', async () => {
  const patched = await readFile(patchUrl, 'utf8')

  assert.match(patched, /const option = options\.find\(\(entry\) => entry\.id === preset\)/)
  assert.match(patched, /function agentPresetHeaderName\(presetId, resolvedName\)/)
  assert.match(patched, /presetId === "reliable-development" \|\| presetId === "reliable-local" \? "CyberMarcus" : resolvedName \?\? presetId/)
  assert.match(patched, /agentPresetHeaderName\(preset, text\?\.name\)/)
	assert.match(patched, /current: this\.staged \?\? this\.currentSession\(\)\?\.agentPreset \?\? this\.fallback/)
	assert.doesNotMatch(patched, /VISIBLE_PRESET_ID/)
})

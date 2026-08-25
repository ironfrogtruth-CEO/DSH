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

test('picker and settings project only reliable-development while the host roster stays broad', async () => {
  const [patched, installed] = await Promise.all([
    readFile(patchUrl, 'utf8'),
    readFile(installedUrl, 'utf8'),
  ])

  assert.equal(installed, patched, 'live bundle must be the reviewed modified bundle')

  const helperSource = section(
    patched,
    'const VISIBLE_PRESET_ID = "reliable-development";',
    '\n\t\tconst INITIAL$2',
  )
  const helpers = Function(`${helperSource}; return { VISIBLE_PRESET_ID, visiblePresetRoster, presetOptions }`)()
  const roster = [
    { id: 'standard', trust: 'system' },
    { id: 'reliable-development', trust: 'user', isDefault: true },
    { id: 'reliable-local', trust: 'user' },
    { id: 'cordis', trust: 'system' },
  ]

  assert.equal(helpers.VISIBLE_PRESET_ID, 'reliable-development')
  assert.deepEqual(
    helpers.visiblePresetRoster(roster).map((preset) => preset.id),
    ['reliable-development'],
  )
  assert.deepEqual(
    helpers.presetOptions(roster).map((preset) => preset.id),
    ['reliable-development'],
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
  assert.match(patched, /const sessionPreset = this\.currentSession\(\)\?\.agentPreset;/)
  assert.match(patched, /sessionPreset === VISIBLE_PRESET_ID \? sessionPreset : this\.fallback/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  MARKER,
  MODIFIED_TITLE,
  ORIGINAL,
  ORIGINAL_TITLE,
  patchToolCallPresentationTitles,
} from './patch-tool-call-presentation-titles.mjs'

test('patch uses Host generic presentCall title and is idempotent', () => {
  const source = `prefix\n${ORIGINAL}\n${ORIGINAL_TITLE}\nsuffix\n`
  const first = patchToolCallPresentationTitles(source)
  assert.equal(first.changed, true)
  assert.match(first.text, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(first.text, /block\.callView\?\.card === "generic"/)
  assert.equal(first.text.includes(MODIFIED_TITLE), true)
  const second = patchToolCallPresentationTitles(first.text)
  assert.equal(second.changed, false)
  assert.equal(second.text, first.text)
})

test('patch fails closed when the rc.2 anchors drift', () => {
  assert.throws(() => patchToolCallPresentationTitles('upstream changed'), /TOOL_TITLE_PATCH_DRIFT/)
})

test('live rc.2 bundle contains the replay marker', async () => {
  const target = resolve(import.meta.dirname, '../install/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js')
  const source = await readFile(target, 'utf8')
  assert.equal(source.includes(MARKER), true)
  assert.equal(source.includes(MODIFIED_TITLE), true)
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const patchUrl = new URL('./client.js.modified', import.meta.url)
const installedUrl = new URL('../../install/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', import.meta.url)

test('conversation patch keeps only native shrimp task tabs and fails stale views closed to chat', async () => {
  const [patched, installed] = await Promise.all([
    readFile(patchUrl, 'utf8'),
    readFile(installedUrl, 'utf8'),
  ])

  assert.equal(installed, patched)
  assert.match(patched, /new Set\(\["chat", "shrimp-catch", "shrimp-library"\]\)/)
  assert.match(patched, /new Set\(\[\.\.\.PRIMARY_VIEW_IDS, "trajectory"\]\)/)
  assert.match(patched, /ACTIVE_VIEW_IDS\.has\(selectedId \?\? ""\) \? selectedId : DEFAULT_VIEW_ID/)
  assert.match(patched, /allViews\(\)\.filter\(\(view\) => PRIMARY_VIEW_IDS\.has\(view\.id\)\)/)
  assert.match(patched, /let activeHeaderSessionId = null/)
  assert.match(patched, /const sessionChanged = activeHeaderSessionId !== sessionId/)
  assert.match(patched, /if \(sessionChanged && currentView !== DEFAULT_VIEW_ID\) actions\.setView\(DEFAULT_VIEW_ID\)/)
})

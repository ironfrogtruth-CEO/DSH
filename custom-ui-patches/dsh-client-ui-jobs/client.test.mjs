import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('./', import.meta.url)
const originalUrl = new URL('./client.js.original', root)
const patchUrl = new URL('./client.js.modified', root)
const installedUrl = new URL('../../install/node_modules/@deepseek-ai/dsh-client-ui-jobs/lib/client.js', root)

function applySection(source) {
  const start = source.indexOf('\n\t\tfunction apply(ctx)')
  assert.notEqual(start, -1, 'missing jobs apply function')
  const end = source.indexOf('\n\t\t//#endregion', start)
  assert.notEqual(end, -1, 'missing jobs apply section end')
  return source.slice(start, end)
}

test('live jobs bundle is the reviewed replayable header-action patch', async () => {
  const [patched, installed] = await Promise.all([
    readFile(patchUrl, 'utf8'),
    readFile(installedUrl, 'utf8'),
  ])
  assert.equal(installed, patched, 'live bundle must equal client.js.modified')
  assert.match(patched, /function JobListAction\(\{ sessionId, useSessions, t \}\)/)
  assert.match(patched, /"status\.running": "运行中"/)
  assert.match(patched, /"status\.completed": "已完成"/)
  assert.match(patched, /"status\.failed": "已失败"/)
})

test('background jobs remain a session-header action and never register a view/tab', async () => {
  const [original, patched] = await Promise.all([
    readFile(originalUrl, 'utf8'),
    readFile(patchUrl, 'utf8'),
  ])
  const apply = applySection(patched)
  assert.match(apply, /ctx\.slots\.inject\("conversation\.session\.header\.actions"/)
  assert.match(apply, /id: "job-list"/)
  assert.match(apply, /order: 20/)
  assert.match(apply, /\}, JobListAction\)\)/)
  assert.doesNotMatch(apply, /conversation\.view|tabIndicator|job-list-indicator/)
  assert.equal(applySection(original), apply, 'only the old view/tab registration must be removed')
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('./', import.meta.url)
const originalUrl = new URL('./client.js.original', root)
const patchUrl = new URL('./client.js.modified', root)
const installedUrl = new URL('../../install/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js', root)

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle)
  assert.notEqual(start, -1, `missing source section: ${startNeedle}`)
  const end = source.indexOf(endNeedle, start)
  assert.notEqual(end, -1, `missing source section end: ${endNeedle}`)
  return source.slice(start, end)
}

test('live workspace bundle is the reviewed replayable patch', async () => {
  const [patched, installed] = await Promise.all([
    readFile(patchUrl, 'utf8'),
    readFile(installedUrl, 'utf8'),
  ])

  assert.equal(installed, patched, 'live bundle must be the reviewed modified bundle')
  assert.equal((patched.match(/\[local-mod\] Keep the ungrouped account/g) ?? []).length, 1)
  assert.match(patched, /const visibleGroups = .*projectWorkspaceGroups\(groups\)/)
  assert.match(patched, /visibleGroups\.map\(\(group\) => \{/)
})

test('ungrouped data stays recoverable while its grouped-sidebar row is hidden', async () => {
  const [original, patched] = await Promise.all([
    readFile(originalUrl, 'utf8'),
    readFile(patchUrl, 'utf8'),
  ])
  const helperSource = section(
    patched,
    '/** [local-mod] Keep the ungrouped account',
    '\n\t\tfunction sessionNode',
  )
  const { projectWorkspaceGroups } = Function(`${helperSource}; return { projectWorkspaceGroups }`)()
  const workspace = {
    key: 'workspace-1',
    workspaceId: 'workspace-1',
    label: 'PPT',
    sessions: [{ id: 'session-in-workspace' }],
  }
  const loose = {
    key: '',
    workspaceId: undefined,
    label: 'Ungrouped',
    sessions: [{ id: 'session-loose' }],
  }
  const groups = [workspace, loose]
  const visible = projectWorkspaceGroups(groups)

  assert.deepEqual(visible, [workspace])
  assert.equal(groups.length, 2, 'projection must not delete the Host-derived ungrouped group')
  assert.deepEqual(groups[1].sessions, [{ id: 'session-loose' }], 'loose session membership must remain intact')
  assert.equal(visible[0], workspace, 'workspace rows must remain unchanged')
  assert.equal(
    section(original, 'function deriveFlat(', '\n\t\t/**\n\t\t* Merge immediate title/Workspace').trim(),
    section(patched, 'function deriveFlat(', '\n\t\t/**\n\t\t* Merge immediate title/Workspace').trim(),
    'flat-session recovery projection must remain unchanged',
  )
})

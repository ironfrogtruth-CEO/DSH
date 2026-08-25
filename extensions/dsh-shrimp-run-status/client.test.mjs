import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientUrl = new URL('./client.js', import.meta.url)
const conversationPatchUrl = new URL('../../custom-ui-patches/dsh-client-ui-conversation/client.js.modified', import.meta.url)
const conversationInstalledUrl = new URL('../../install/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', import.meta.url)

test('run-status client is a browser-only slot extension with durable source and polling seams', async () => {
  const source = await readFile(clientUrl, 'utf8')
  assert.match(source, /var module = \{ exports: \{\} \}/)
  assert.match(source, /var exports = module\.exports/)
  assert.match(source, /id: '@local\/dsh-shrimp-run-status'/)
  assert.match(source, /conversation\.session\.run-status/)
  assert.match(source, /runningCalls/)
  assert.match(source, /nodes/)
  assert.match(source, /pending.*approval/)
  assert.match(source, /\/api\/v1\/runs\/\$\{encodeURIComponent\(activeRunId\)\}\/summary/)
  assert.match(source, /\/api\/v1\/runs\/\$\{encodeURIComponent\(activeRunId\)\}\/status/)
  assert.match(source, /heartbeat_gzh_publish/)
  assert.match(source, /\/api\/dsh-shrimp-run-status\/heartbeat/)
  assert.match(source, /\/api\/v1\/pipelines\/\$\{encodeURIComponent\(heartbeat\.pipelineSlug\)\}\/summary/)
  assert.match(source, /setInterval\(\(\) => \{ void read\(\) \}, 3000\)/)
  assert.match(source, /data-shrimp-kind/)
  assert.match(source, /shrimp:request-library/)
  assert.match(source, /dsh-shrimp-run-status:dismissed/)
  assert.match(source, /dsh-shrimp-run-status-close/)
  assert.match(source, /terminalState && dismissalId/)
  assert.match(source, /candidate\?\.runId \|\| candidate\?\.callId/)
  assert.match(source, /saveDismissed\(storageKey\(sessionId, dismissalId\)\); setDismissed\(true\)/)
  const patch = await readFile(new URL('./cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: dsh-shrimp-run-status/)
})

test('conversation patch and installed bundle expose the formal session run-status slot at chat start', async () => {
  const [patch, installed] = await Promise.all([readFile(conversationPatchUrl, 'utf8'), readFile(conversationInstalledUrl, 'utf8')])
  assert.equal(installed, patch)
  assert.match(patch, /"conversation\.session\.run-status": \{\n\s*kind: "single",\n\s*scope: "session"\n\s*\}/)
  assert.match(patch, /renderSlot\("conversation\.session\.run-status", \{\}\)/)
})

test('run-status stylesheet keeps the card zero-height when no run and supports narrow/reduced-motion layouts', async () => {
  const source = await readFile(clientUrl, 'utf8')
  assert.match(source, /if \(!candidate \|\| dismissed\) return null/)
  assert.match(source, /@media\(max-width:760px\)/)
  assert.match(source, /prefers-reduced-motion:reduce/)
  assert.match(source, /overflow-x:auto/)
  assert.match(source, /source\.length <= 6/)
})

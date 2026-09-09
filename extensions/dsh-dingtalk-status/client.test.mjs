import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

test('footer entry is a one-click recover button with toast, no dialog', async () => {
  const source = await readFile(join(import.meta.dirname, 'client.js'), 'utf8')
  assert.match(source, /sidebar\.footer\.action/)
  assert.match(source, /const inject = \['slots'\]/)
  assert.match(source, /\/api\/mobile-gateway\/action/)
  assert.match(source, /action: 'recover'/)
  assert.match(source, /一键全量恢复|已全量恢复/)
  assert.match(source, /dsh-mobile-gateway-toast/)
  assert.match(source, /data-dsh-sidebar-foot/)
  assert.doesNotMatch(source, /role: 'dialog'|window\.confirm\(|backdrop/)
  assert.doesNotMatch(source, /启动隧道|停止中|重新连接/)
})

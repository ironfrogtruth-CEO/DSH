import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

test('mobile gateway client uses the footer seam with explicit action surface', async () => {
  const source = await readFile(join(import.meta.dirname, 'client.js'), 'utf8')
  assert.match(source, /sidebar\.footer\.action/)
  assert.match(source, /const inject = \['slots'\]/)
  assert.match(source, /移动端连接/)
  assert.match(source, /\/api\/mobile-gateway\/status/)
  assert.match(source, /\/api\/mobile-gateway\/action/)
  assert.match(source, /postAction/)
  assert.match(source, /重新连接/)
  assert.match(source, /启动隧道/)
  assert.match(source, /SNI/)
  assert.match(source, /data-dsh-sidebar-foot/)
  // The legacy DingTalk panel content is gone.
  assert.doesNotMatch(source, /收任务\/续聊\/审批\/图片\/流式结果/)
  assert.doesNotMatch(source, /最近钉钉会话/)
  // Stop is confirm-guarded; restart/start are explicit posts only.
  assert.match(source, /确定停止移动端隧道/)
  assert.doesNotMatch(source, /exec\(|spawn\(/)
})

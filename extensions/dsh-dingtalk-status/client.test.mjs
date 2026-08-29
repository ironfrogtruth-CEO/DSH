import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

test('DingTalk client uses the existing footer seam, is read-only, and documents capability limits', async () => {
  const source = await readFile(join(import.meta.dirname, 'client.js'), 'utf8')
  assert.match(source, /sidebar\.footer\.action/)
  assert.match(source, /const inject = \['slots', 'sessions'\]/)
  assert.match(source, /钉钉/)
  assert.match(source, /收任务\/续聊\/审批\/图片\/流式结果/)
  assert.match(source, /不支持入站文件、音频、视频/)
  assert.match(source, /setupCommand/)
  assert.match(source, /复制命令/)
  assert.doesNotMatch(source, /POST|PUT|DELETE|exec\(|spawn\(|sessionWebhook|Client Secret|staffId/)
  assert.match(source, /不会自动执行/)
  assert.match(source, /data-dsh-sidebar-foot/)
  assert.match(source, /\[data-dsh-footer-actions\],\[data-dsh-settings-area\]\{display:contents!important\}/)
  assert.match(source, /grid-column:1 \/ -1/)
  assert.match(source, /dsbalance-card/)
  assert.match(source, /最近钉钉会话/)
  assert.match(source, /session\.title/)
  assert.match(source, /ctx\.sessions\.open\.bind\(ctx\.sessions\)/)
  assert.match(source, /dsh:open-session/)
  assert.match(source, /打开对应会话/)
  assert.doesNotMatch(source, /setCurrent|interrupt|cancelSession/)
})

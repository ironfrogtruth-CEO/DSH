import assert from 'node:assert/strict'
import test from 'node:test'

import { createNativeAdminClient, hasNativeAdminBridge, shouldRenderAdminPanel } from './native-client.js'

import { readFile } from 'node:fs/promises'

test('native admin client only posts through WebKit and resolves Swift callback data', async () => {
  const messages = []
  const windowRef = {
    webkit: { messageHandlers: { dingtalkSubscriptionAdmin: { postMessage(value) { messages.push(value) } } } },
  }
  assert.equal(hasNativeAdminBridge(windowRef), true)
  assert.equal(shouldRenderAdminPanel(windowRef), true)
  const client = createNativeAdminClient(windowRef, { timeoutMs: 2_000 })
  const pending = client.request('subscriber.list', { limit: 10 })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].action, 'subscriber.list')
  assert.deepEqual(messages[0].payload, { limit: 10 })
  windowRef.__dshDingTalkSubscriptionAdminResult({ requestId: messages[0].requestId, ok: true, data: ['one'] })
  assert.deepEqual(await pending, ['one'])
  client.dispose()
})

test('ordinary browser has no admin panel and no HTTP fallback', async () => {
  const windowRef = {}
  assert.equal(hasNativeAdminBridge(windowRef), false)
  assert.equal(shouldRenderAdminPanel(windowRef), false)
  const client = createNativeAdminClient(windowRef)
  await assert.rejects(client.request('subscriber.create', {}), (error) => error.code === 'NATIVE_BRIDGE_UNAVAILABLE')
  client.dispose()
})

test('browser entry is a ModuleLoader bundle and hides itself without WebKit bridge', async () => {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load/)
  assert.match(source, /dingtalkSubscriptionAdmin/)
  assert.match(source, /if \(!bridgeAvailable\(\) \|\| !ctx\?\.slots\) return/)
  assert.match(source, /dsh:open-dingtalk-subscriptions/)
  assert.match(source, /dsh:open-dingtalk-status/)
  assert.doesNotMatch(source, /className: 'dsh-sub-trigger'/)
  assert.match(source, /新增并生成二维码/)
  assert.match(source, /registration\.begin/)
  assert.match(source, /请订阅者使用钉钉扫码/)
  assert.match(source, /扫码未完成绑定/)
  assert.match(source, /dsh-sub-kind-picker/)
  assert.match(source, /基础配置已完成/)
  assert.match(source, /授予后会自动进入下一项/)
  assert.match(source, /scrollIntoView/)
  assert.match(source, /（可选）/)
  assert.doesNotMatch(source, /必须与虾缸正式名称完全一致/)
  assert.match(source, /模式.*工作区.*模型.*推理强度.*虾/s)
  assert.doesNotMatch(source, /h\('select', \{ key: 'kind'/)
  assert.match(source, /删除订阅者/)
  assert.match(source, /工作区、会话、额度和审计仍会保留/)
  assert.match(source, /robot\.list/)
  assert.match(source, /我已完成品牌设置，启动机器人/)
  assert.match(source, /刷新10分钟确认窗口/)
  assert.match(source, /在私聊中回复“确认绑定”/)
  assert.match(source, /brand-avatar\.png/)
  assert.match(source, /workspace\.share/)
  assert.match(source, /workspace\.host-create/)
  assert.match(source, /选择已有/)
  assert.match(source, /新建工作区/)
  assert.match(source, /使用这个工作区/)
  assert.match(source, /创建并使用这个工作区/)
  assert.match(source, /工作区已存在，已直接选中/)
  assert.match(source, /万 Token\/周/)
  assert.match(source, /保存额度/)
  assert.match(source, /已启用/)
  assert.match(source, /workspaceSummary/)
  assert.match(source, /ENTITLEMENT_LABELS\[item\.kind\]/)
  assert.match(source, /授权与默认/)
  assert.doesNotMatch(source, /selection: '选择'/)
  assert.match(source, /万 Token/)
  assert.doesNotMatch(source, /fetch\s*\(/u)
})

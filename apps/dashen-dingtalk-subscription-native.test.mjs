import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = import.meta.dirname
const sourcePath = join(root, '大神.swift')

test('native DingTalk subscription admin bridge keeps the capability outside JavaScript', async () => {
  const source = await readFile(sourcePath, 'utf8')
  assert.match(source, /DINGTALK_SUBSCRIPTION_ADMIN_TOKEN/)
  assert.match(source, /\.dsh\/private\/dingtalk-subscriptions\/native-admin-token/)
  assert.match(source, /userContentController\.add\(self, name: "dingtalkSubscriptionAdmin"\)/)
  assert.match(source, /message\.frameInfo\.isMainFrame/)
  assert.match(source, /isInternalURL\(currentURL\)/)
  assert.match(source, /X-Dashen-Native-Admin/)
  assert.match(source, /window\.__dshDingTalkSubscriptionAdminResult/)
  assert.match(source, /document\.documentElement\.dataset\.dashenNativeAdmin = 'true'/)
  assert.doesNotMatch(source, /window\.[A-Za-z0-9_$]*nativeAdminToken/)
  assert.doesNotMatch(source, /evaluateJavaScript\([^\n]*token/)
})

test('native bridge exposes only the fixed subscriber administration action set', async () => {
  const source = await readFile(sourcePath, 'utf8')
  for (const action of [
    'subscriber.create', 'subscriber.suspend', 'subscriber.resume', 'subscriber.revoke', 'robot.list', 'workspace.create', 'workspace.share',
    'entitlement.grant', 'entitlement.revoke', 'quota.reset',
    'registration.begin', 'registration.status', 'catalog.list', 'audit.list',
  ]) assert.match(source, new RegExp(`"${action}"`))
  assert.match(source, /dingtalkSubscriptionAdminActions\.contains\(action\)/)
  assert.match(source, /result\["data"\] = dictionary\["data"\] \?\? dictionary/)
})

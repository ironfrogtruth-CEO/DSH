import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ADMIN_API_PATH,
  ADMIN_TOKEN_HEADER,
  BRAND_AVATAR_SHA256,
  BRAND_DESCRIPTION,
  BRAND_NAME,
  DingTalkSubscriptionService,
  SUBSCRIBER_ASSERTION_HEADER,
  SUBSCRIBER_SIGNATURE_HEADER,
  SubscriptionError,
  createNativeAdminRoute,
  createBrandAvatarRoute,
  ensureIdentityHmacKey,
  usageFromValue,
  apply as applySubscriptionPlugin,
} from './index.js'
import { ShrimpTankSubscriberClient, SHRIMPTANK_ENDPOINTS } from './shrimp-client.js'
import { verifyBrandAsset } from './brand.js'
import { evaluateSubscriberToolCall } from './policy.js'
import { dateKey, isAllowedWorkdayFromCalendar, defaultCalendar } from './calendar.js'
import { canonicalJson, signSubscriberAssertionClaims } from './index.js'

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-subscriptions-'))
  const service = new DingTalkSubscriptionService({
    privateRoot: root,
    dbPath: join(root, 'subscriptions.sqlite'),
    hmacSecret: 'unit-test-hmac-secret',
    ...options,
  })
  return { root, service }
}

async function cleanup(root, service) {
  service?.close()
  await rm(root, { recursive: true, force: true })
}

async function provision(service, root, displayName = '订阅者') {
  const subscriber = service.createSubscriber({ displayName, weeklyTokenLimit: 100 })
  const account = service.registerRobotAccount({ subscriberId: subscriber.subscriberId, credentialRef: `dingtalk:credential:${subscriber.subscriberId}` })
  service.updateRobotBrand(account.accountId, { name: BRAND_NAME, description: BRAND_DESCRIPTION, avatarSha256: BRAND_AVATAR_SHA256 })
  const workspace = service.createWorkspace({ subscriberId: subscriber.subscriberId, displayName: `${displayName}工作区`, rootPath: join(root, subscriber.subscriberId), createDirectory: true })
  service.grantWorkspace(subscriber.subscriberId, workspace.workspaceId)
  service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'mode', resourceId: 'reliable-development', displayName: '可靠开发' })
  service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'model', provider: 'deepseek', model: 'deepseek-chat', displayName: 'DeepSeek Chat', usageMetered: true, metadata: { usageMetered: true } })
  service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'effort', resourceId: 'medium', displayName: '中' })
  service.setSelections(subscriber.subscriberId, { modeId: 'reliable-development', workspaceId: workspace.workspaceId, model: { provider: 'deepseek', model: 'deepseek-chat' }, effortId: 'medium' })
  const challenge = service.beginBindingChallenge(subscriber.subscriberId, { accountId: account.accountId })
  service.completeBindingChallenge({ challengeId: challenge.challengeId, challengeToken: challenge.challengeToken, accountId: account.accountId, senderStaffId: `${subscriber.subscriberId}-staff` })
  return { subscriber, account, workspace }
}

test('SQLite schema is WAL-backed, private, and identity key survives restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-subscriptions-'))
  const service = new DingTalkSubscriptionService({ privateRoot: root, dbPath: join(root, 'subscriptions.sqlite') })
  try {
    const names = service.store.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name)
    for (const name of ['subscribers', 'robot_accounts', 'entitlements', 'selections', 'quota_cycles', 'quota_reservations', 'session_lineage', 'holiday_calendars', 'audit_events', 'binding_challenges', 'outbox']) assert.ok(names.includes(name), name)
    assert.equal(service.store.pragma('journal_mode').journal_mode, 'wal')
    const dbMode = (await stat(join(root, 'subscriptions.sqlite'))).mode & 0o777
    assert.equal(dbMode, 0o600)
    const key = await stat(join(root, 'identity-hmac-key'))
    assert.equal(key.mode & 0o777, 0o600)
    const systemToken = await stat(join(root, 'shrimptank-system-token'))
    assert.equal(systemToken.mode & 0o777, 0o600)
    const identityKey = await readFile(join(root, 'identity-hmac-key'))
    service.close()
    const second = new DingTalkSubscriptionService({ privateRoot: root, dbPath: join(root, 'subscriptions.sqlite') })
    assert.deepEqual(await readFile(join(root, 'identity-hmac-key')), identityKey)
    second.close()
  } finally {
    await cleanup(root, service)
  }
})

test('subscriber lifecycle requires robot brand, binding, workspace, entitlements and selection', async () => {
  const { root, service } = await fixture()
  try {
    const subscriber = service.createSubscriber({ displayName: 'Alice', weeklyTokenLimit: 100 })
    assert.equal(subscriber.status, 'pending')
    const account = service.registerRobotAccount({ subscriberId: subscriber.subscriberId, credentialRef: 'dingtalk:credential:alice' })
    assert.equal(service.getSubscriber(subscriber.subscriberId).status, 'waiting_robot')
    service.updateRobotBrand(account.accountId, { name: BRAND_NAME, description: BRAND_DESCRIPTION, avatarSha256: BRAND_AVATAR_SHA256 })
    assert.equal(service.getSubscriber(subscriber.subscriberId).status, 'waiting_binding')
    const challenge = service.beginBindingChallenge({ subscriberId: subscriber.subscriberId, accountId: account.accountId })
    assert.match(challenge.qrPayload, /^dsh-dingtalk-binding:/u)
    const pendingAccess = service.authorizeInbound({ accountId: account.accountId, senderStaffId: 'staff-alice', conversationType: 'direct' })
    assert.equal(pendingAccess.kind, 'pending-binding')
    assert.equal(pendingAccess.challengeId, challenge.challengeId)
    assert.equal(service.store.get('SELECT token_hash FROM binding_challenges WHERE challenge_id = ?', challenge.challengeId).token_hash.includes(challenge.challengeToken), false)
    assert.throws(() => service.completeBindingChallenge({ challengeId: challenge.challengeId, challengeToken: 'wrong', accountId: account.accountId, senderStaffId: 'staff-alice' }), (error) => error.code === 'BINDING_CHALLENGE_INVALID')
    const workspace = service.createWorkspace({ subscriberId: subscriber.subscriberId, rootPath: join(root, 'alice'), createDirectory: true })
    service.grantWorkspace(subscriber.subscriberId, workspace.workspaceId)
    service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'mode', resourceId: 'reliable-development', displayName: '可靠开发' })
    service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'model', provider: 'deepseek', model: 'deepseek-chat', displayName: 'DeepSeek Chat', usageMetered: true, metadata: { usageMetered: true } })
    service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'effort', resourceId: 'medium', displayName: '中' })
    service.setSelections(subscriber.subscriberId, { modeId: 'reliable-development', workspaceId: workspace.workspaceId, model: 'deepseek/deepseek-chat', effortId: 'medium' })
    const bound = service.completeBinding({ challengeId: challenge.challengeId, challengeToken: challenge.challengeToken, accountId: account.accountId, senderStaffId: 'staff-alice' })
    assert.equal(bound.subscriber.status, 'active')
    assert.equal(service.authorizeInbound({ accountId: account.accountId, senderStaffId: 'staff-alice', conversationType: 'direct' }).allowed, true)
    assert.equal(service.authorizeInbound({ accountId: account.accountId, senderStaffId: 'staff-alice', conversationType: 'group' }).code, 'DIRECT_CHAT_REQUIRED')
    assert.equal(service.authorizeInbound({ accountId: account.accountId, senderStaffId: 'staff-other', conversationType: 'direct' }).allowed, false)
    const staleRevision = subscriber.revision
    assert.throws(() => service.updateSubscriber(subscriber.subscriberId, { displayName: 'stale' }, { expectedRevision: staleRevision }), (error) => error.code === 'CAS_CONFLICT')
  } finally {
    await cleanup(root, service)
  }
})

test('direct private-chat confirmation consumes the current pending binding without exposing its token', async () => {
  const { root, service } = await fixture()
  try {
    const subscriber = service.createSubscriber({ displayName: 'Direct Binding User', weeklyTokenLimit: 100 })
    const account = service.registerRobotAccount({ subscriberId: subscriber.subscriberId, credentialRef: 'dingtalk:credential:direct-binding' })
    service.updateRobotBrand(account.accountId, { name: BRAND_NAME, description: BRAND_DESCRIPTION, avatarSha256: BRAND_AVATAR_SHA256 })
    const workspace = service.createWorkspace({ subscriberId: subscriber.subscriberId, rootPath: join(root, 'direct-binding'), createDirectory: true })
    service.grantWorkspace(subscriber.subscriberId, workspace.workspaceId)
    service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'mode', resourceId: 'reliable-development', displayName: '可靠开发' })
    service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'model', provider: 'deepseek', model: 'deepseek-chat', displayName: 'DeepSeek Chat', usageMetered: true, metadata: { usageMetered: true } })
    service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'effort', resourceId: 'medium', displayName: '中' })
    service.setSelections(subscriber.subscriberId, { modeId: 'reliable-development', workspaceId: workspace.workspaceId, model: 'deepseek/deepseek-chat', effortId: 'medium' })
    const challenge = service.beginBindingChallenge({ subscriberId: subscriber.subscriberId, accountId: account.accountId })
    assert.throws(() => service.confirmPendingBinding({ accountId: account.accountId, challengeId: challenge.challengeId, senderStaffId: 'staff-direct', conversationType: 'group' }), (error) => error.code === 'DIRECT_CHAT_REQUIRED')
    const confirmed = service.confirmPendingBinding({ accountId: account.accountId, challengeId: challenge.challengeId, senderStaffId: 'staff-direct', conversationType: 'direct' })
    assert.equal(confirmed.kind, 'bound')
    assert.equal(confirmed.status, 'active')
    assert.equal(service.getSubscriber(subscriber.subscriberId).identityBound, true)
    assert.equal(service.authorizeInbound({ accountId: account.accountId, senderStaffId: 'staff-direct', conversationType: 'direct' }).allowed, true)
  } finally {
    await cleanup(root, service)
  }
})

test('exact shrimp matching never accepts aliases, slugs, discovery or ungranted names', async () => {
  const { root, service } = await fixture()
  try {
    const { subscriber } = await provision(service, root, 'Shrimp User')
    service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'shrimp', resourceId: 'shrimp-formal-1', displayName: '企业健康报告生产虾', remoteAcknowledged: true })
    const catalog = [{ id: 'shrimp-formal-1', slug: 'health-report', display_name: '企业健康报告生产虾' }, { id: 'shrimp-other', slug: 'other', display_name: '另一只虾' }]
    assert.equal(service.exactShrimpMatch(subscriber.subscriberId, '帮我写一份总结', catalog).requested, false)
    assert.equal(service.exactShrimpMatch(subscriber.subscriberId, '请运行企业健康报告生产虾', catalog).ok, true)
    assert.equal(service.exactShrimpMatch(subscriber.subscriberId, '请运行企业健康报告生产虾').ok, true)
    const matched = service.exactShrimpMatch(subscriber.subscriberId, '请运行企业健康报告生产虾')
    const receipt = service.authorizeShrimpInvocation({ subscriberId: subscriber.subscriberId, sessionId: 'session-shrimp', messageId: 'message-1', resourceId: matched.resourceId, displayName: matched.displayName })
    assert.equal(evaluateSubscriberToolCall({ toolName: 'shrimp_run', arguments: { pipelineSlug: matched.resourceId }, invocationReceiptValid: false }).allowed, false)
    assert.equal(service.consumeShrimpInvocation({ receiptId: receipt.receiptId, subscriberId: subscriber.subscriberId, sessionId: 'session-shrimp', messageId: 'message-1', resourceId: matched.resourceId }).allowed, true)
    assert.equal(service.consumeShrimpInvocation({ receiptId: receipt.receiptId, subscriberId: subscriber.subscriberId, sessionId: 'session-shrimp', messageId: 'message-1', resourceId: matched.resourceId }).allowed, false)
    for (const value of ['请运行 health-report', '请运行企业健康报告', '请推荐一只虾', '请运行另一只虾']) {
      const result = service.exactShrimpMatch(subscriber.subscriberId, value, catalog)
      assert.equal(result.ok, false)
      assert.equal(result.reason, '这只虾不存在或你没有使用权限。')
    }
    assert.equal(service.listEntitlements(subscriber.subscriberId, { forSubscriber: true }).some((item) => item.kind === 'shrimp'), false)
  } finally {
    await cleanup(root, service)
  }
})

test('2026 adjusted weekend workdays are allowed, holidays and unknown years fail closed', async () => {
  const { root, service } = await fixture()
  try {
    assert.equal(service.isAllowedWorkday('2026-02-14'), true)
    assert.equal(service.isAllowedWorkday('2026-02-28'), true)
    assert.equal(service.isAllowedWorkday('2026-05-09'), true)
    assert.equal(service.isAllowedWorkday('2026-09-20'), true)
    assert.equal(service.isAllowedWorkday('2026-10-10'), true)
    assert.equal(service.isAllowedWorkday('2026-02-15'), false)
    assert.equal(service.isAllowedWorkday('2026-02-16'), false)
    assert.equal(service.isAllowedWorkday('2026-02-13'), true)
    assert.equal(service.isAllowedWorkday('2027-01-04'), false)
    assert.equal(dateKey('2026-02-14T01:00:00Z'), '2026-02-14')
    assert.equal(isAllowedWorkdayFromCalendar('2026-02-14', defaultCalendar(2026)), true)
  } finally {
    await cleanup(root, service)
  }
})

test('quota reservation is atomic, idempotent, settles/releases, and reset keeps an audit trail', async () => {
  const { root, service } = await fixture()
  try {
    const { subscriber } = await provision(service, root, 'Quota User')
    const first = service.reserveQuota(subscriber.subscriberId, 60, { at: '2026-02-14', idempotencyKey: 'request-1' })
    const retry = service.reserveQuota(subscriber.subscriberId, 60, { at: '2026-02-14', idempotencyKey: 'request-1' })
    assert.equal(retry.idempotent, true)
    assert.equal(retry.reservation.reservationId, first.reservation.reservationId)
    assert.throws(() => service.reserveQuota(subscriber.subscriberId, 50, { at: '2026-02-14', idempotencyKey: 'request-2' }), (error) => error.code === 'QUOTA_EXHAUSTED')
    service.settleQuota(first.reservation.reservationId, 55)
    const second = service.reserveQuota(subscriber.subscriberId, 40, { at: '2026-02-14', idempotencyKey: 'request-3' })
    service.releaseQuota(second.reservation.reservationId)
    const status = service.quotaStatus(subscriber.subscriberId, { at: '2026-02-14' })
    assert.equal(status.usedTokens, 55)
    assert.equal(status.reservedTokens, 0)
    const reset = service.resetQuota(subscriber.subscriberId, { at: '2026-02-14' })
    assert.equal(reset.usedTokens, 0)
    assert.ok(service.auditEvents({ subscriberId: subscriber.subscriberId }).some((event) => event.action === 'quota.reset'))
    assert.throws(() => service.reserveQuota(subscriber.subscriberId, 1, { at: '2026-02-15' }), (error) => error.code === 'HOLIDAY_OR_REST_DAY')
  } finally {
    await cleanup(root, service)
  }
})

test('updating the weekly quota changes the active cycle limit without resetting usage', async () => {
  const now = () => new Date('2026-09-01T02:00:00+08:00')
  const { root, service } = await fixture({ now })
  try {
    const { subscriber } = await provision(service, root, 'Quota Limit User')
    const first = service.reserveQuota(subscriber.subscriberId, 30, { at: '2026-09-01', idempotencyKey: 'limit-change-1' })
    service.settleQuota(first.reservation.reservationId, 25)
    const current = service.getSubscriber(subscriber.subscriberId)
    service.updateSubscriber(subscriber.subscriberId, { weeklyTokenLimit: 10_000 }, { expectedRevision: current.revision })
    const status = service.quotaStatus(subscriber.subscriberId, { at: '2026-09-01' })
    assert.equal(status.cycle.limitTokens, 10_000)
    assert.equal(status.usedTokens, 25)
    assert.equal(status.remainingTokens, 9_975)
  } finally {
    await cleanup(root, service)
  }
})

test('quota reset releases every outstanding reservation and clears stale reserved totals', async () => {
  const { root, service } = await fixture()
  try {
    const { subscriber } = await provision(service, root, 'Quota Reset User')
    const lease = service.beginQuotaLease(subscriber.subscriberId, { at: '2026-02-14', requestId: 'stale-before-reset' })
    const reset = service.resetQuota(subscriber.subscriberId, { at: '2026-02-14' })
    assert.equal(reset.reservedTokens, 0)
    assert.equal(service.store.get('SELECT state FROM quota_reservations WHERE reservation_id = ?', lease.lease.reservationId).state, 'released')
    assert.equal(service.store.get('SELECT SUM(reserved_tokens) AS total FROM quota_cycles WHERE subscriber_id = ?', subscriber.subscriberId).total, 0)
  } finally {
    await cleanup(root, service)
  }
})

test('subscriber model usage is metered and missing usage fails closed while owner remains unaffected', async () => {
  const { root, service } = await fixture()
  try {
    const { subscriber } = await provision(service, root, 'Usage User')
    const lease = service.beginQuotaLease(subscriber.subscriberId, { at: '2026-02-14', requestId: 'usage-turn' })
    assert.equal(service.authorizeModelCall({ subscriberId: subscriber.subscriberId, model: 'deepseek/deepseek-chat', usage: { prompt_tokens: 3, completion_tokens: 2 } }).allowed, true)
    assert.throws(() => service.recordSubscriberUsage({ subscriberId: subscriber.subscriberId, reservationId: lease.lease.reservationId, model: 'deepseek/deepseek-chat', usage: null }), (error) => error.code === 'USAGE_REQUIRED')
    service.recordSubscriberUsage({ subscriberId: subscriber.subscriberId, reservationId: lease.lease.reservationId, model: 'deepseek/deepseek-chat', usage: { prompt_tokens: 3, completion_tokens: 2 } })
    service.finalizeQuotaLease(lease.lease.reservationId)
    assert.equal(service.authorizeModelCall({ actorRole: 'system_owner', subscriberId: subscriber.subscriberId, model: 'unknown/model', usage: null }).allowed, true)
  } finally {
    await cleanup(root, service)
  }
})

test('catalog lazily resolves workspaces, model reasoning metadata, metered providers and nested ShrimpTank items', async () => {
  const { root, service } = await fixture({
    workspaceRegistryResolver: () => ({ list: () => [{ id: 'host-workspace', title: '大神主工作区', path: join(root, 'host-workspace'), sessionIds: [] }] }),
    llmResolver: () => ({
      listProviders: () => [{ id: 'deepseek-official' }],
      listModels: () => [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      resolveModelInfo: () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }),
    }),
    shrimpCatalogResolver: () => ({ listPublished: () => [{ ref: 'safe-shrimp', display_name: '正式安全虾', lifecycle_status: 'published' }] }),
  })
  try {
    await mkdir(join(root, 'host-workspace'), { recursive: true })
    const catalog = await service.listCatalog()
    assert.equal(catalog.workspaces.find((item) => item.workspaceId === 'host-workspace').source, 'host')
    assert.equal(catalog.models[0].usageMetered, true)
    assert.deepEqual(catalog.models[0].efforts, ['low', 'high'])
    assert.deepEqual(catalog.efforts.map((item) => item.resourceId), ['low', 'high'])
    assert.equal(catalog.shrimps[0].displayName, '正式安全虾')
  } finally {
    await cleanup(root, service)
  }
})

test('sharing a Host workspace creates one subscriber workspace grant and complete grants auto-select defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subscription-share-'))
  const hostRoot = join(root, 'host-workspace')
  await mkdir(hostRoot, { recursive: true })
  const service = new DingTalkSubscriptionService({ privateRoot: root, dbPath: join(root, 'share.sqlite'), hmacSecret: 'unit-test-hmac-secret', workspaceRegistryResolver: () => ({ get: (workspaceId) => workspaceId === 'host-workspace' ? { id: workspaceId, title: '共享工作区', path: hostRoot } : undefined }) })
  try {
    const subscriber = service.createSubscriber({ displayName: '共享用户', weeklyTokenLimit: 10_000 })
    service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'mode', resourceId: 'reliable-development', displayName: 'CyberMarcus' })
    service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', usageMetered: true })
    service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'effort', resourceId: 'high', displayName: '高' })
    const shared = service.shareHostWorkspace({ subscriberId: subscriber.subscriberId, hostWorkspaceId: 'host-workspace' })
    assert.equal(shared.rootPath, hostRoot)
    assert.equal((await service.listCatalog()).workspaces.find((item) => item.workspaceId === shared.workspaceId).source, 'shared')
    assert.equal(service.listEntitlements(subscriber.subscriberId).filter((item) => item.kind === 'workspace' && item.status === 'active').length, 1)
    assert.deepEqual(service.getSelections(subscriber.subscriberId), { subscriberId: subscriber.subscriberId, modeId: 'reliable-development', workspaceId: shared.workspaceId, modelProvider: 'deepseek-official', modelId: 'deepseek-v4-pro', effortId: 'high', revision: 1, updatedAt: service.getSelections(subscriber.subscriberId).updatedAt })
  } finally {
    await cleanup(root, service)
  }
})

test('creating the same workspace again reuses and re-grants it instead of returning WORKSPACE_EXISTS', async () => {
  const { root, service } = await fixture()
  try {
    const subscriber = service.createSubscriber({ displayName: 'Workspace Reuse User', weeklyTokenLimit: 10_000 })
    const rootPath = join(root, 'reused-workspace')
    const first = service.createWorkspace({ subscriberId: subscriber.subscriberId, displayName: '已有工作区', rootPath, createDirectory: true })
    const second = service.createWorkspace({ subscriberId: subscriber.subscriberId, displayName: '重复创建', rootPath, createDirectory: true })
    assert.equal(second.workspaceId, first.workspaceId)
    assert.equal(second.reused, true)
    assert.equal(service.listWorkspaces(subscriber.subscriberId).length, 1)
    assert.equal(service.listEntitlements(subscriber.subscriberId).filter((item) => item.kind === 'workspace' && item.status === 'active').length, 1)
    assert.ok(service.auditEvents({ subscriberId: subscriber.subscriberId }).some((event) => event.action === 'workspace.reuse'))
  } finally {
    await cleanup(root, service)
  }
})

test('host workspace creation publishes to the main registry and subscriber sessions attach to it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-workspace-'))
  const hostRows = new Map()
  const attached = []
  const registry = {
    list: () => [...hostRows.values()],
    get: (workspaceId) => hostRows.get(workspaceId),
    resolveByPath: async (path) => [...hostRows.values()].find((item) => item.path === path),
    async create(path, title) {
      const workspace = { id: 'host-created', path, title, sessionIds: [], async attachSession(sessionId) { attached.push(sessionId) } }
      hostRows.set(workspace.id, workspace)
      return workspace
    },
  }
  const service = new DingTalkSubscriptionService({ privateRoot: root, dbPath: join(root, 'subscriptions.sqlite'), hmacSecret: 'unit-test-hmac-secret', workspaceRegistryResolver: () => registry })
  try {
    const subscriber = service.createSubscriber({ displayName: 'Host Workspace User', weeklyTokenLimit: 10_000 })
    const account = service.registerRobotAccount({ subscriberId: subscriber.subscriberId, credentialRef: 'dingtalk:credential:host-workspace' })
    const created = await service.createHostWorkspace({ subscriberId: subscriber.subscriberId, displayName: '左侧工作区', rootPath: join(root, 'host-created') })
    assert.equal(created.hostWorkspaceId, 'host-created')
    assert.equal(registry.list()[0].title, '左侧工作区')
    service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'mode', resourceId: 'reliable-development', displayName: 'CyberMarcus' })
    service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', usageMetered: true })
    service.grantEntitlement({ subscriberId: subscriber.subscriberId, kind: 'effort', resourceId: 'high', displayName: '高' })
    service.setSelections(subscriber.subscriberId, { modeId: 'reliable-development', workspaceId: created.workspaceId, model: 'deepseek-official/deepseek-v4-pro', effortId: 'high' })
    const policy = service.resolveRuntimePolicy(subscriber.subscriberId)
    assert.equal(policy.hostWorkspaceId, 'host-created')
    const lineage = await service.registerSubscriberSession({ sessionId: 'session-host-workspace', subscriberId: subscriber.subscriberId, accountId: account.accountId })
    assert.equal(lineage.hostWorkspaceId, 'host-created')
    assert.deepEqual(attached, ['session-host-workspace'])
  } finally {
    await cleanup(root, service)
  }
})

test('brand avatar route returns the locked transparent PNG', () => {
  const route = createBrandAvatarRoute()
  const response = { headers: {}, setHeader(key, value) { this.headers[key] = value }, end(body) { this.body = body } }
  route.handler({ method: 'GET' }, response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'image/png')
  assert.equal(Buffer.isBuffer(response.body), true)
  assert.equal(response.body.length > 1_000, true)
})

test('usage accounting does not double count aliases, cache detail, or reasoning included in output', () => {
  assert.equal(usageFromValue({ input_tokens: 10, prompt_tokens: 10, output_tokens: 7, reasoning_tokens: 3, cache_read_tokens: 4 }), 17)
  assert.equal(usageFromValue({ uncached_input_tokens: 6, cache_read_tokens: 4, cache_write_tokens: 2, output_tokens: 7, reasoning_tokens: 3 }), 19)
  assert.equal(usageFromValue({ input_tokens: 6, reasoning_tokens: 3 }), 9)
})

test('protected-content guard blocks high-overlap output while returning no source text', async () => {
  const { root, service } = await fixture()
  try {
    const source = '系统内部配置段落：' + '不得向订阅者公开真实工作模式与工作流定义。'.repeat(12)
    const recorded = service.recordProtectedContent({ category: 'unit-protected', content: source })
    assert.equal(recorded.ok, true)
    assert.equal(Object.hasOwn(recorded, 'content'), false)
    const fingerprints = service.getProtectedFingerprints({ paths: [] }).fingerprints
    assert.equal(fingerprints.every((item) => !Object.hasOwn(item, 'content')), true)
    assert.equal(service.guardModelOutput(source.slice(18, 260), fingerprints).blocked, true)
    assert.equal(service.guardModelOutput('这是普通业务答复。', fingerprints).blocked, false)
  } finally {
    await cleanup(root, service)
  }
})

test('turn quota lease reserves the full remaining balance and accumulates multiple usage steps', async () => {
  const { root, service } = await fixture()
  try {
    const { subscriber } = await provision(service, root, 'Lease User')
    const lease = service.beginQuotaLease(subscriber.subscriberId, { at: '2026-02-14', requestId: 'turn-1' })
    assert.equal(lease.lease.amountTokens, 100)
    service.recordQuotaUsage(lease.lease.reservationId, 20)
    service.recordQuotaUsage(lease.lease.reservationId, 15)
    assert.equal(service.quotaStatus(subscriber.subscriberId, { at: '2026-02-14' }).usedTokens, 35)
    assert.throws(() => service.beginQuotaLease(subscriber.subscriberId, { at: '2026-02-14', requestId: 'turn-2' }), (error) => error.code === 'QUOTA_EXHAUSTED')
    const done = service.finalizeQuotaLease(lease.lease.reservationId)
    assert.equal(done.lease.actualTokens, 35)
    assert.equal(done.lease.state, 'settled')
    const retry = service.finalizeQuotaLease(lease.lease.reservationId)
    assert.equal(retry.idempotent, true)
  } finally {
    await cleanup(root, service)
  }
})

test('native admin HTTP route rejects browser writes and dispatches token-authenticated CAS actions', async () => {
  const { root, service } = await fixture()
  try {
    const route = createNativeAdminRoute(service)
    const calls = []
    const response = () => ({ statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value }, end(body) { this.body = JSON.parse(body); calls.push(this) } })
    const denied = response()
    await route.handler({ method: 'POST', headers: {}, body: { action: 'subscriber.create', payload: { displayName: 'Denied' } } }, denied)
    assert.equal(denied.statusCode, 403)
    const allowed = response()
    await route.handler({ method: 'POST', headers: { [ADMIN_TOKEN_HEADER.toLowerCase()]: service.nativeAdminToken }, body: { action: 'subscriber.create', payload: { displayName: 'Native', weeklyTokenLimit: 10 } } }, allowed)
    assert.equal(allowed.statusCode, 200)
    assert.equal(allowed.body.ok, true)
    assert.equal(allowed.body.data.displayName, 'Native')
    assert.equal(calls.length, 2)
    assert.equal(ADMIN_API_PATH, route.path)
  } finally {
    await cleanup(root, service)
  }
})

test('async Cordis apply resolves only to a disposer or undefined, never the service object', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subscription-apply-'))
  const effects = []
  const provided = new Map()
  const ctx = {
    credentials: { async resolve() { return null } },
    webServer: { register() { return () => {} } },
    on() { return () => {} },
    effect(callback) { effects.push(callback); return () => {} },
    provide(name, value) { provided.set(name, value) },
    get() { return null },
  }
  try {
    const result = await applySubscriptionPlugin(ctx, { privateRoot: root, dbPath: join(root, 'apply.sqlite'), disableOutboxProcessor: true })
    assert.equal(result, undefined)
    assert.ok(provided.get('dingtalkSubscriptions'))
    const dispose = effects[0]()
    assert.equal(typeof dispose, 'function')
    dispose()
  } finally {
    provided.get('dingtalkSubscriptions')?.close?.()
    await rm(root, { recursive: true, force: true })
  }
})

test('assertions, session lineage, robot account listeners and hard policy gate stay tenant-bound', async () => {
  const { root, service } = await fixture()
  try {
    const { subscriber, account, workspace } = await provision(service, root, 'Assertion User')
    const currentSubscriber = service.getSubscriber(subscriber.subscriberId)
    service.updateSubscriber(subscriber.subscriberId, { metadata: { ...currentSubscriber.metadata, shrimptankAccountId: 'tank-account-assert', shrimptankUserId: 'tank-user-assert' } }, { expectedRevision: currentSubscriber.revision })
    service.beginQuotaLease(subscriber.subscriberId, { at: '2026-02-14', requestId: 'assertion-turn' })
    const events = []
    const dispose = service.onRobotAccountsChanged((snapshot, event) => events.push({ snapshot, event }))
    const assertion = service.createSubscriberAssertion({ subscriberId: subscriber.subscriberId, accountId: account.accountId, userId: 'staff-assertion', scopes: ['pipeline:run'] })
    assert.equal(service.verifySubscriberAssertion(assertion.assertion, assertion.signature).valid, true)
    assert.equal(assertion.headers[SUBSCRIBER_ASSERTION_HEADER], assertion.assertion)
    assert.equal(assertion.headers[SUBSCRIBER_SIGNATURE_HEADER], assertion.signature)
    service.registerSession({ sessionId: 'session-main', subscriberId: subscriber.subscriberId, accountId: account.accountId, agentId: 'agent-main' })
    assert.equal(service.resolveSubscriberForSession('session-main'), subscriber.subscriberId)
    assert.equal(service.resolveSubscriberForAgent('agent-main'), subscriber.subscriberId)
    const sessionAssertion = service.createSubscriberAssertionForSession({ sessionId: 'session-main', scopes: ['pipeline:run'] })
    assert.equal(service.verifySubscriberAssertion(sessionAssertion.assertion, sessionAssertion.signature).valid, true)
    assert.equal(service.resolveRuntimePolicy(subscriber.subscriberId).workspaceRoot, workspace.rootPath)
    assert.equal(evaluateSubscriberToolCall({ toolName: 'read', arguments: { path: join(root, 'outside.txt') }, workspaceRoot: workspace.rootPath }).allowed, false)
    assert.equal(evaluateSubscriberToolCall({ toolName: 'bash', arguments: { command: `cat $HOME/.dsh/private/secret` }, workspaceRoot: workspace.rootPath }).allowed, false)
    assert.equal(evaluateSubscriberToolCall({ toolName: 'terminal', arguments: { command: `cat ${encodeURIComponent('../outside')}` }, workspaceRoot: workspace.rootPath }).allowed, false)
    assert.equal(evaluateSubscriberToolCall({ toolName: 'read', arguments: { path: join(workspace.rootPath, '.dsh', 'config') }, workspaceRoot: workspace.rootPath }).allowed, false)
    assert.equal(evaluateSubscriberToolCall({ toolName: 'shrimp_list', arguments: {} }).allowed, false)
    assert.equal(evaluateSubscriberToolCall({ toolName: 'shrimp_run', arguments: {}, shrimpAuthorized: false }).allowed, false)
    service.suspendSubscriber(subscriber.subscriberId)
    assert.equal(service.listActiveRobotSpecs().length, 0)
    assert.ok(events.length >= 1)
    dispose()
  } finally {
    await cleanup(root, service)
  }
})

test('brand asset is the generated 512x512 transparent mark', () => {
  const value = verifyBrandAsset()
  assert.equal(value.ok, true)
  assert.equal(value.width, 512)
  assert.equal(value.height, 512)
  assert.equal(value.transparent, true)
  assert.equal(value.borderless, true)
})

test('registration returns a QR-safe verification URI, polls registrationId job, and never persists device code or credentials', async () => {
  const { root, service } = await fixture()
  try {
    const waits = []
    let resolveWait
    const manager = {
      async beginRegistration() { return { registrationId: 'reg_1', verificationUriComplete: 'https://dingtalk.example/verify?code=opaque', deviceCode: 'DO_NOT_RETURN' } },
      waitForCredentials(registrationId, params) { waits.push({ registrationId, params }); return new Promise((resolve) => { resolveWait = resolve }) },
      async cancel() { return { status: 'cancelled' } },
    }
    service.registrationManager = manager
    const subscriber = service.createSubscriber({ displayName: 'Registration User' })
    const begun = await service.beginRegistration({ subscriberId: subscriber.subscriberId })
    assert.equal(begun.registrationId, 'reg_1')
    assert.equal(begun.verificationUri, 'https://dingtalk.example/verify?code=opaque')
    assert.match(begun.qrSvg, /<svg/u)
    assert.equal(begun.deviceCode, undefined)
    assert.equal((await service.registrationStatus({ subscriberId: subscriber.subscriberId, registrationId: 'reg_1' })).status, 'pending')
    resolveWait({ status: 'succeeded', accountId: 'acct_1', clientId: 'secret-client-id', clientSecret: 'secret-client-secret' })
    for (let index = 0; index < 20 && (await service.registrationStatus({ subscriberId: subscriber.subscriberId, registrationId: 'reg_1' })).status === 'pending'; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
    const status = await service.registrationStatus({ subscriberId: subscriber.subscriberId, registrationId: 'reg_1' })
    assert.equal(status.status, 'brand-pending')
    assert.equal(status.clientSecret, undefined)
    assert.equal(waits[0].registrationId, 'reg_1')
    const dbText = service.store.all('SELECT details_json FROM audit_events').map((row) => row.details_json).join('\n')
    assert.equal(dbText.includes('opaque'), false)
    assert.equal(dbText.includes('secret-client-secret'), false)
  } finally {
    await cleanup(root, service)
  }
})

test('registration fails instead of reporting success when scan credentials were not persisted', async () => {
  const { root, service } = await fixture()
  try {
    service.registrationManager = {
      async beginRegistration() { return { registrationId: 'reg_not_persisted', verificationUriComplete: 'https://dingtalk.example/verify?code=retry' } },
      async waitForCredentials() { return { status: 'succeeded', accountId: 'acct_missing', persisted: false } },
    }
    const subscriber = service.createSubscriber({ displayName: 'Registration Persistence User' })
    await service.beginRegistration({ subscriberId: subscriber.subscriberId })
    let status
    for (let index = 0; index < 20; index += 1) {
      status = await service.registrationStatus({ subscriberId: subscriber.subscriberId, registrationId: 'reg_not_persisted' })
      if (status.status !== 'pending') break
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    assert.equal(status.status, 'failed')
    assert.match(status.error, /未被大神安全接管/u)
    assert.equal(service.listRobotAccounts(subscriber.subscriberId).length, 0)
    assert.equal(service.store.get('SELECT status FROM outbox WHERE idempotency_key = ?', 'registration:reg_not_persisted').status, 'failed')
  } finally {
    await cleanup(root, service)
  }
})

test('assertion fixed vector uses epoch seconds and hex HMAC', () => {
  const claims = { accountId: 'tank-account', expiresAt: 1_700_000_300, issuedAt: 1_700_000_000, nonce: 'fixed-nonce', robotAccountId: 'robot-1', scopes: ['pipeline:run'], subscriberId: 'sub-1', userId: 'tank-user' }
  const { encoded, signature } = signSubscriberAssertionClaims(claims, 'vector-secret')
  assert.equal(encoded, Buffer.from(canonicalJson(claims)).toString('base64url'))
  assert.equal(signature, '27aa7b495027b48002b8bf5936cd47b6bf1cbbf48f17bad4173a318af4fa9962')
})

test('credential persistence writes only keychain names and rolls back partial writes', async () => {
  const { root, service } = await fixture()
  try {
    const values = new Map()
    const writer = {
      async set(name, value) { values.set(name, value) },
      async unset(name) { values.delete(name) },
      async resolve(name) { return values.get(name) },
    }
    service.credentialWriter = writer
    service.credentialResolver = writer
    const subscriber = service.createSubscriber({ displayName: 'Credential User' })
    const persisted = await service.persistRobotCredentials({ subscriberId: subscriber.subscriberId, accountId: 'acct_credential', clientId: 'client-id', clientSecret: 'client-secret' })
    assert.equal(persisted.credentialRef, 'DINGTALK_SUBSCRIBER_ACCT_CREDENTIAL')
    assert.equal(values.get(`${persisted.credentialRef}_CLIENT_ID`), 'client-id')
    assert.equal(values.get(`${persisted.credentialRef}_CLIENT_SECRET`), 'client-secret')
    assert.equal(service.getRobotAccount('acct_credential').credentialRef, persisted.credentialRef)
    assert.deepEqual(await service.resolveRobotCredentials({ accountId: 'acct_credential' }), { accountId: 'acct_credential', subscriberId: subscriber.subscriberId, clientId: 'client-id', clientSecret: 'client-secret', credentialRef: persisted.credentialRef })
    const failingValues = new Map()
    const failingWriter = { async set(name, value) { if (name.endsWith('_CLIENT_SECRET')) throw new Error('write failed'); failingValues.set(name, value) }, async unset(name) { failingValues.delete(name) } }
    const failingService = new DingTalkSubscriptionService({ privateRoot: await mkdtemp(join(tmpdir(), 'dsh-dingtalk-cred-fail-')), hmacSecret: 'test-secret', credentialWriter: failingWriter })
    const failingSubscriber = failingService.createSubscriber({ displayName: 'Fail User' })
    await assert.rejects(failingService.persistRobotCredentials({ subscriberId: failingSubscriber.subscriberId, accountId: 'acct_fail', clientId: 'id', clientSecret: 'secret' }), (error) => error.code === undefined || error.message === 'write failed')
    assert.equal(failingValues.size, 0)
    failingService.close()
  } finally {
    await cleanup(root, service)
  }
})

test('ShrimpTank sync keeps shrimp entitlement pending until a remote receipt', async () => {
  const { root, service } = await fixture()
  try {
    const { subscriber } = await provision(service, root, 'Tank User')
    const calls = []
    const client = new ShrimpTankSubscriberClient({ service, systemToken: 'unit-system-token', fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/api/v1/system/subscribers')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, account_id: 'tank-account-1', user_id: 'tank-user-1' }) }
      if (url.endsWith('/api/v1/dsh/shrimps')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, items: [{ id: 'shrimp-pipeline', status: 'published', display_name: '正式生产虾' }] }) }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, account_id: 'tank-account-1', user_id: 'tank-user-1' }) }
    } })
    const result = await client.grantPipeline({ subscriberId: subscriber.subscriberId, pipelineSlug: 'shrimp-pipeline', displayName: '正式生产虾' })
    assert.equal(result.ok, true)
    assert.equal(result.entitlement.status, 'active')
    assert.equal(service.getSubscriber(subscriber.subscriberId).metadata.shrimptankAccountId, 'tank-account-1')
    assert.equal(calls[0].url, `${client.baseUrl}${SHRIMPTANK_ENDPOINTS.upsertSubscriber}`)
    const upsertBody = JSON.parse(calls[0].options.body)
    assert.equal(upsertBody.workspace_root, service.resolveRuntimePolicy(subscriber.subscriberId).workspaceRoot)
    assert.equal(upsertBody.weekly_token_limit, 100)
    assert.ok(Array.isArray(upsertBody.entitlements.modes))
    assert.ok(!Object.hasOwn(upsertBody, 'shrimps'))
    assert.ok(calls.some((call) => call.url === `${client.baseUrl}${SHRIMPTANK_ENDPOINTS.grantPipeline(subscriber.subscriberId, 'shrimp-pipeline')}`))
    assert.equal(calls[0].options.headers.Authorization, 'Bearer unit-system-token')
    assert.equal(calls[0].options.headers['X-System-Principal-Token'], 'unit-system-token')

    const unavailable = new ShrimpTankSubscriberClient({ service, systemToken: 'unit-system-token', fetchImpl: async () => { throw new Error('offline') } })
    const pending = await unavailable.grantPipeline({ subscriberId: subscriber.subscriberId, pipelineSlug: 'shrimp-pipeline-2', displayName: '离线虾' })
    assert.equal(pending.ok, false)
    assert.equal(pending.pending, true)
    assert.equal(pending.entitlement.status, 'pending')
  } finally {
    await cleanup(root, service)
  }
})

test('ShrimpTank published catalog accepts the canonical data.items envelope', async () => {
  const { root, service } = await fixture()
  try {
    const client = new ShrimpTankSubscriberClient({ service, systemToken: 'unit-system-token', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: { items: [{ ref: 'shrimp-one', display_name: '第一只虾', lifecycle_status: 'published' }] } }) }) })
    const items = await client.listPublished()
    assert.equal(items.length, 1)
    assert.equal(items[0].display_name, '第一只虾')
  } finally {
    await cleanup(root, service)
  }
})

test('ShrimpTank calendar sync sends every date with an explicit workday boolean', async () => {
  const { root, service } = await fixture()
  try {
    const calls = []
    const client = new ShrimpTankSubscriberClient({ service, systemToken: 'unit-system-token', fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
    } })
    const result = await client.syncCalendar(2026)
    assert.equal(result.ok, true)
    const payload = JSON.parse(calls[0].options.body)
    assert.equal(calls[0].url, `${client.baseUrl}/api/v1/system/subscriber-calendars/2026`)
    assert.equal(payload.entries.length, 365)
    assert.deepEqual(payload.entries.find((entry) => entry.date === '2026-02-14'), { date: '2026-02-14', is_workday: true })
    assert.deepEqual(payload.entries.find((entry) => entry.date === '2026-02-15'), { date: '2026-02-15', is_workday: false })
  } finally {
    await cleanup(root, service)
  }
})

test('ShrimpTank outbox reclaims a stale processing row after Host restart', async () => {
  const { root, service } = await fixture()
  try {
    const row = service.enqueueOutbox({ kind: 'shrimptank.calendar.sync', aggregateId: '2026', idempotencyKey: 'calendar-stale', payload: { year: 2026 } })
    service.markOutbox(row.outboxId, 'processing')
    service.store.run('UPDATE outbox SET updated_at = ? WHERE outbox_id = ?', '2026-01-01T00:00:00.000Z', row.outboxId)
    const calls = []
    const client = new ShrimpTankSubscriberClient({ service, systemToken: 'unit-system-token', timeoutMs: 250, fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) } } })
    const drained = await client.drainOutbox()
    assert.equal(drained.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(service.listOutbox().find((item) => item.outboxId === row.outboxId).status, 'completed')
  } finally {
    await cleanup(root, service)
  }
})

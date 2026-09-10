// @local/dsh-mobile-push — 会话完成后移动端 Web Push 的插件侧。
//
// 职责：
//   1. 提供 VAPID 公钥配置、订阅登记与测试推送三个 API。
//   2. 检测"会话回合完成"并把推送任务写入 outbox.jsonl；真正的
//      Web Push 发送由 ~/.dsh/scripts/mobile-push-watcher.py 守护完成，
//      本插件不直接发起网络推送。
//
// 会话完成信号（2026-09-09 已核实源码）：
//   - dsh-session 的 Session.append 会把每个事件以 "session/event" 名义
//     dispatch 到会话 emitCtx（lib/index.js:1469-1476）。
//   - dsh-session/lib/invariant.js:142-148 作为普通插件用
//     ctx.on("session/event", ..., { global: true }) 成功订阅，证明宿主级
//     插件可订阅该事件。
//   - "turn/end" 事件 data 为 { turn: <number>, reason: {...} }（
//     lib/index.js:716-721），即"一个会话回合完成"。
//   - dsh-agent-loop 只在 agent 自身 scope 内 emit "agent/status"（无全局
//     订阅面），因此另备 5s setInterval 轮询 agents.list() 的
//     running→非running 转变作为兜底；两条路径共用按 (sessionId, turn)
//     的去重，确保一个回合只写一条 outbox。
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-mobile-push'
export const inject = ['webServer', 'sessionQuery', 'sessionPersistence', 'agents']

export const MAX_BODY_CHARS = 60
export const MAX_BODY_BYTES = 16 * 1024
export const POLL_INTERVAL_MS = 5_000
export const COMPLETION_TITLE = '大神 · 会话已完成'
export const TEST_TITLE = '大神 · 测试推送'

export function statePaths({ home = homedir() } = {}) {
  const dir = process.env.DSH_MOBILE_PUSH_DIR || join(home, '.dsh', 'private', 'mobile-push')
  return {
    dir,
    vapid: join(dir, 'vapid.json'),
    subscriptions: join(dir, 'subscriptions.json'),
    outbox: join(dir, 'outbox.jsonl'),
  }
}

export function endpointFingerprint(endpoint) {
  return createHash('sha256').update(String(endpoint)).digest('hex')
}

/** 校验并归一化订阅体；不合法返回 null。 */
export function normalizeSubscribeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : ''
  if (!/^https?:\/\//.test(endpoint) || endpoint.length > 2048) return null
  const keys = body.keys && typeof body.keys === 'object' && !Array.isArray(body.keys) ? body.keys : null
  const p256dh = typeof keys?.p256dh === 'string' ? keys.p256dh.trim() : ''
  const auth = typeof keys?.auth === 'string' ? keys.auth.trim() : ''
  if (!p256dh || !auth || p256dh.length > 512 || auth.length > 512) return null
  return { endpoint, keys: { p256dh, auth }, fingerprint: endpointFingerprint(endpoint) }
}

/** 按 endpoint 指纹去重合并；已存在时更新 keys，返回 {list, changed}。 */
export function mergeSubscriptions(existing, next) {
  const list = Array.isArray(existing) ? existing.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : []
  const index = list.findIndex((item) => item?.fingerprint === next.fingerprint)
  if (index >= 0) {
    const before = JSON.stringify(list[index].keys)
    list[index] = { ...list[index], endpoint: next.endpoint, keys: next.keys }
    return { list, changed: before !== JSON.stringify(next.keys) }
  }
  list.push({ ...next, subscribedAt: new Date().toISOString() })
  return { list, changed: true }
}

export function truncateBody(text, max = MAX_BODY_CHARS) {
  const clean = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(0, max - 1))}…`
}

/** 从会话事件流里找最后一条用户消息的纯文本（倒序，找到即返回）。 */
export function lastUserTextFromEvents(events) {
  if (!Array.isArray(events)) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const message = event.data && typeof event.data === 'object' ? event.data.message : null
    if (!message || typeof message !== 'object') continue
    // 插件快照类用户消息（source.kind === 'plugin'）是运行时内部投影，跳过。
    if (message.source?.kind === 'plugin') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ')
      .trim()
    if (text) return truncateBody(text)
  }
  return ''
}

/** 按已核实的 settled-array batch 合同从 sessionQuery 读标题。 */
export function sessionTitleFromSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const meta = value.meta && typeof value.meta === 'object' ? value.meta : value.session && typeof value.session === 'object' ? value.session : value
  const titleValue = value.title && typeof value.title === 'object' ? value.title.title : value.title
  return truncateBody(titleValue || meta.title || meta.displayTitle || meta.label || '')
}

export async function lookupSessionTitle(sessionId, sessionQuery) {
  if (typeof sessionQuery?.readTitleSnapshots !== 'function') return ''
  try {
    const results = await sessionQuery.readTitleSnapshots.call(sessionQuery, [sessionId])
    const item = Array.isArray(results)
      ? results.find((candidate) => candidate?.status === 'fulfilled' && candidate?.sessionId === sessionId)
      : null
    return sessionTitleFromSnapshot(item?.value)
  } catch {
    return ''
  }
}

/** agent 上最后一个 turn 序号（从已落盘事件倒序找 turn/end 或 turn/start）。 */
export function lastTurnFromAgent(agent) {
  const events = agent?.session?.events
  if (!Array.isArray(events)) return 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type
    if (type === 'turn/end' || type === 'turn/start') {
      const turn = events[index]?.data?.turn
      return typeof turn === 'number' && Number.isSafeInteger(turn) ? turn : 0
    }
  }
  return 0
}

/**
 * 按 (sessionId, turn) 幂等地决定是否应通知；命中则更新内存游标。
 * turn <= 0 或重复回合返回 false。
 */
export function shouldNotifyCompletion(state, sessionId, turn) {
  if (!state || typeof state.notifiedTurns !== 'object' || state.notifiedTurns === null) return false
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn <= 0) return false
  const previous = state.notifiedTurns.get(sessionId) ?? 0
  if (turn <= previous) return false
  state.notifiedTurns.set(sessionId, turn)
  return true
}

export function buildOutboxTask({ title, body, path = '/', extra = {} } = {}) {
  return {
    id: randomUUID(),
    title: truncateBody(title, 80),
    body: truncateBody(body),
    path,
    attempts: 0,
    createdAt: new Date().toISOString(),
    ...extra,
  }
}

export async function appendOutboxLine(outboxPath, task) {
  await mkdir(statePathsLikeDir(outboxPath), { recursive: true, mode: 0o700 })
  const handle = await open(outboxPath, 'a', 0o600)
  try {
    await handle.write(`${JSON.stringify(task)}\n`, null, 'utf8')
  } finally {
    await handle.close()
  }
}

function statePathsLikeDir(outboxPath) {
  // outbox 路径形如 <dir>/outbox.jsonl；目录即其 dirname。
  const index = outboxPath.lastIndexOf('/')
  return index > 0 ? outboxPath.slice(0, index) : '.'
}

async function readVapidPublic(vapidPath) {
  try {
    const raw = await readFile(vapidPath, 'utf8')
    const value = JSON.parse(raw)
    const publicKey = typeof value?.public === 'string' ? value.public : ''
    return publicKey || null
  } catch {
    return null
  }
}

async function readSubscriptions(subscriptionsPath) {
  try {
    const raw = await readFile(subscriptionsPath, 'utf8')
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

async function writeSubscriptionsAtomic(subscriptionsPath, list) {
  const tmp = `${subscriptionsPath}.tmp-${process.pid}-${Date.now()}`
  await mkdir(statePathsLikeDir(subscriptionsPath), { recursive: true, mode: 0o700 })
  await open(tmp, 'wx', 0o600).then(async (handle) => {
    try {
      await handle.write(JSON.stringify(list, null, 2), null, 'utf8')
    } finally {
      await handle.close()
    }
  })
  await rename(tmp, subscriptionsPath)
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > maxBytes) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return null
  }
}

/** 构造会话完成检测的纯逻辑状态与处理函数，便于测试。 */
export function createCompletionTracker({ sessionQuery, agents } = {}) {
  const state = { notifiedTurns: new Map() }
  const handleCompletion = async (sessionId, turn, session) => {
    if (!shouldNotifyCompletion(state, sessionId, turn)) return null
    const paths = statePaths()
    let body = await lookupSessionTitle(sessionId, sessionQuery)
    if (!body) body = lastUserTextFromEvents(session?.events)
    if (!body) body = '会话回合已完成'
    const task = buildOutboxTask({ title: COMPLETION_TITLE, body })
    await appendOutboxLine(paths.outbox, task)
    return task
  }
  return { state, handleCompletion }
}

export function capturePushServices(ctx) {
  return {
    sessionQuery: ctx.sessionQuery,
    sessionPersistence: ctx.sessionPersistence,
    agents: ctx.agents,
  }
}

/** 生成四个 API 的 handler（纯依赖 paths），便于 node --test 直测。 */
export function createApiHandlers({ paths = statePaths() } = {}) {
  return {
    config: async (req, res) => {
      if (req.method && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '只允许 GET' })
        return
      }
      const vapidPublicKey = await readVapidPublic(paths.vapid)
      if (!vapidPublicKey) {
        sendJson(res, 503, { ok: false, error: 'VAPID 公钥未配置' })
        return
      }
      sendJson(res, 200, { ok: true, vapidPublicKey })
    },
    subscribe: async (req, res) => {
      if (req.method && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只允许 POST' })
        return
      }
      const body = await readJsonBody(req)
      const subscription = normalizeSubscribeBody(body)
      if (!subscription) {
        sendJson(res, 400, { ok: false, error: '订阅字段不完整：需要 endpoint 与 keys.p256dh/keys.auth' })
        return
      }
      const existing = await readSubscriptions(paths.subscriptions)
      const { list, changed } = mergeSubscriptions(existing, subscription)
      if (changed) await writeSubscriptionsAtomic(paths.subscriptions, list)
      sendJson(res, 200, { ok: true, count: list.length })
    },
    test: async (req, res) => {
      if (req.method && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只允许 POST' })
        return
      }
      const subscriptions = await readSubscriptions(paths.subscriptions)
      const task = buildOutboxTask({ title: TEST_TITLE, body: '这是一条测试推送，收到即链路正常。' })
      await appendOutboxLine(paths.outbox, task)
      sendJson(res, 200, { ok: true, queued: true, count: subscriptions.length })
    },
    clear: async (req, res) => {
      if (req.method && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只允许 POST' })
        return
      }
      const task = buildOutboxTask({ title: '', body: '', extra: { clear: true } })
      await appendOutboxLine(paths.outbox, task)
      sendJson(res, 200, { ok: true, cleared: true })
    },
  }
}

export function apply(ctx) {
  // Cordis 在插件 setup 后会收窄 context；HTTP handler 与事件监听必须
  // 在 apply 期间捕获服务引用（与 dsh-dingtalk-status 相同的坑）。
  const { sessionQuery, sessionPersistence, agents } = capturePushServices(ctx)
  const handlers = createApiHandlers()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/mobile-push/config',
    handler: handlers.config,
  }), 'dsh-mobile-push: config api')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/mobile-push/subscribe',
    handler: handlers.subscribe,
  }), 'dsh-mobile-push: subscribe api')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/mobile-push/test',
    handler: handlers.test,
  }), 'dsh-mobile-push: test api')

  // 打开页面后由移动壳调用：写入 clear 信号行，watcher 收到后把未读数清零。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/mobile-push/clear',
    handler: handlers.clear,
  }), 'dsh-mobile-push: clear api')

  const tracker = createCompletionTracker({ sessionQuery, sessionPersistence, agents })

  // 主路径：订阅 session/event，turn/end 即一个回合完成。
  // 防御：若宿主级 ctx.on 不支持 { global: true } 选项而抛错，绝不能让
  // 整个插件（含上面的 API 路由）被 cordis 回滚 —— 轮询兜底仍然有效。
  ctx.effect(() => {
    try {
      ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/end') return
        const sessionId = typeof session?.id === 'string' ? session.id : ''
        const turn = event?.data?.turn
        Promise.resolve(tracker.handleCompletion(sessionId, turn, session)).catch(() => {})
      }, { global: true })
      // ctx.on owns listener disposal; Cordis effects must not return booleans.
      return
    } catch {
      return
    }
  }, 'dsh-mobile-push: session/event turn/end')

  // 兜底路径：5s 轮询 agents.list() 的 running→非running 转变。
  ctx.effect(() => {
    const previousStatus = new Map()
    const timer = setInterval(() => {
      try {
        const list = typeof agents?.list === 'function' ? agents.list() : []
        for (const agent of list) {
          const sessionId = typeof agent?.id === 'string' ? agent.id : ''
          if (!sessionId) continue
          const status = agent?.status
          const before = previousStatus.get(sessionId)
          previousStatus.set(sessionId, status)
          if (before !== 'running' || status === 'running') continue
          const turn = lastTurnFromAgent(agent)
          Promise.resolve(tracker.handleCompletion(sessionId, turn, agent?.session)).catch(() => {})
        }
      } catch {
        // 轮询是兜底，任何异常都静默吞掉，不影响宿主。
      }
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, 'dsh-mobile-push: completion poll')
}

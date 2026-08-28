// dsh-webbridge — Host 半身: Agent 工具 webbridge_* + Native Messaging 队列端点
// 用途: CyberMarcus 通过用户真实 Chrome(MV3 扩展 + Native Messaging)执行网页操作,
// 继承真实登录态与浏览器指纹;Playwright 路线保留用于隔离场景,两者并存。
// 通信链路: 工具调用 → 内存队列 → NM host 轮询 POST /api/webbridge/next
//   → 扩展执行(content script)→ 分帧回传 → POST /api/webbridge/result。
export const name = 'dsh-webbridge'

export const inject = ['webServer', 'tools']
export const protocolVersion = 2

import fs from 'node:fs'
import path from 'node:path'

const queue = []
const waiters = []
const results = new Map()
const operations = new Map()
let seq = 0
let lastNativeActivityAt = null
let recentOperation = null
const OPERATION_TTL_MS = 10 * 60 * 1000
const RECENT_OPERATION_GRACE_MS = 1600
const publicCommandKinds = new Set([
  'status', 'list_tabs', 'open_tab', 'close_tab', 'activate_tab',
  'navigate', 'read', 'click', 'trusted_click', 'trusted_key', 'trusted_insert_text',
  'type', 'screenshot', 'hover', 'key', 'wait', 'scroll', 'upload',
  'paste_html', 'clipboard_html', 'eval', 'runtime_reload',
])

function schemaOf(props) {
  const properties = {}
  for (const [k, v] of Object.entries(props)) {
    properties[k] = v.description ? Object.assign({ type: v.type }, { description: v.description }) : { type: v.type }
  }
  return { type: 'object', additionalProperties: false, properties }
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maxBytes) {
        tooLarge = true
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (tooLarge) return reject(new Error('request body exceeds size limit'))
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('request body is not valid JSON')) }
    })
    req.on('error', reject)
  })
}

function operationSnapshot(now = Date.now()) {
  for (const [operationId, operation] of operations) {
    if (Number(operation.expiresAt || 0) <= now) operations.delete(operationId)
  }
  const explicit = [...operations.values()].sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0]
  if (explicit) return { ...explicit, active: true, source: 'lease' }
  const pending = [...results.entries()]
    .map(([cmdId, value]) => ({
      operationId: String(value.command?.operationId || cmdId),
      label: 'Chrome操作中',
      cmdId,
      kind: String(value.command?.kind || ''),
      tabId: value.command?.tabId == null ? null : Number(value.command.tabId),
      startedAt: Number(value.startedAt || now),
      updatedAt: now,
      active: true,
      source: 'command',
    }))
    .filter((item) => Number.isFinite(item.tabId))
    .sort((left, right) => right.startedAt - left.startedAt)[0]
  if (pending) return pending
  if (recentOperation && Number(recentOperation.visibleUntil || 0) > now && Number.isFinite(Number(recentOperation.tabId))) {
    return { ...recentOperation, active: true, source: 'recent' }
  }
  return null
}

function touchOperation(command, now = Date.now()) {
  const operationId = String(command?.operationId || '')
  if (!operationId) return
  const existing = operations.get(operationId)
  if (!existing) return
  const tabId = command?.tabId == null ? existing.tabId : Number(command.tabId)
  operations.set(operationId, {
    ...existing,
    tabId: Number.isFinite(tabId) ? tabId : existing.tabId,
    updatedAt: now,
    expiresAt: now + OPERATION_TTL_MS,
  })
}

function registerRoutes(ctx) {
  const route = {
    kind: 'prefix',
    path: '/api/webbridge',
    handler: async (req, res) => {
      const send = (code, body) => {
        try {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        } catch (e) {}
      }
      const u = new URL(req.url || '/', 'http://localhost')
      const op = u.pathname.replace(/^\/api\/webbridge\/?/, '')
      const contentType = String(req.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
      // /next 和 /result 是跨进程写入/取队列的控制面。只接受带 JSON
      // Content-Type 的 POST，浏览器 no-CORS 页面无法直接抽走或注入队列。
      if (req.method === 'POST' && contentType === 'application/json' && op === 'command') {
        let message
        try { message = await readJsonBody(req, 70 * 1024 * 1024) }
        catch (error) { return send(400, { ok: false, error: error.message }) }
        if (message?.protocol !== protocolVersion) {
          return send(409, { ok: false, error: 'webbridge protocol mismatch', expected: protocolVersion })
        }
        const command = message.command
        if (!command || typeof command !== 'object' || Array.isArray(command) || !publicCommandKinds.has(command.kind)) {
          return send(400, { ok: false, error: 'unsupported or missing webbridge command kind' })
        }
        const timeoutMs = Math.min(Math.max(Number(message.timeoutMs) || 45000, 1000), 180000)
        return send(200, await executeCommand(command, timeoutMs))
      }
      if (req.method === 'POST' && contentType === 'application/json' && op === 'operation') {
        let message
        try { message = await readJsonBody(req, 1024 * 1024) }
        catch (error) { return send(400, { ok: false, error: error.message }) }
        if (message?.protocol !== protocolVersion) {
          return send(409, { ok: false, error: 'webbridge protocol mismatch', expected: protocolVersion })
        }
        const action = String(message.action || '')
        const operationId = String(message.operationId || '').trim()
        if (!operationId || !['begin', 'heartbeat', 'end'].includes(action)) {
          return send(400, { ok: false, error: 'invalid webbridge operation lifecycle' })
        }
        if (action === 'end') {
          operations.delete(operationId)
          return send(200, { ok: true, operationId, active: false })
        }
        const now = Date.now()
        const previous = operations.get(operationId) || {}
        const tabId = message.tabId == null ? previous.tabId : Number(message.tabId)
        if (!Number.isFinite(tabId)) return send(400, { ok: false, error: 'operation tabId is required' })
        const operation = {
          operationId,
          label: String(message.label || previous.label || 'Chrome操作中').slice(0, 80),
          owner: String(message.owner || previous.owner || '').slice(0, 120),
          tabId,
          startedAt: Number(previous.startedAt || now),
          updatedAt: now,
          expiresAt: now + OPERATION_TTL_MS,
        }
        operations.set(operationId, operation)
        return send(200, { ok: true, operation: { ...operation, active: true, source: 'lease' } })
      }
      if (req.method === 'POST' && contentType === 'application/json' && op === 'activate') {
        let message
        try { message = await readJsonBody(req, 1024 * 1024) }
        catch (error) { return send(400, { ok: false, error: error.message }) }
        if (message?.protocol !== protocolVersion) {
          return send(409, { ok: false, error: 'webbridge protocol mismatch', expected: protocolVersion })
        }
        const tabId = Number(message.tabId)
        if (!Number.isFinite(tabId)) return send(400, { ok: false, error: 'activate tabId is required' })
        return send(200, await executeCommand({ kind: 'activate_tab', tabId }, 8000))
      }
      if (req.method === 'POST' && contentType === 'application/json' && (op === 'next' || op === '')) {
        let message
        try { message = await readJsonBody(req, 1024 * 1024) }
        catch (error) { return send(400, { ok: false, error: error.message }) }
        if (message?.protocol !== protocolVersion) {
          return send(409, { ok: false, error: 'webbridge protocol mismatch', expected: protocolVersion })
        }
        lastNativeActivityAt = Date.now()
        const job = queue.shift()
        if (job) return send(200, job)
        let wake
        const p = new Promise((resolve) => {
          wake = resolve
          waiters.push(resolve)
        })
        const t = setTimeout(() => {
          const i = waiters.indexOf(wake)
          if (i >= 0) waiters.splice(i, 1)
          send(200, { idle: true })
          wake(null)
        }, 25000)
        p.then((job2) => {
          clearTimeout(t)
          if (job2) send(200, job2)
        }).catch(() => {})
        return
      }
      if (req.method === 'POST' && op === 'result' && contentType === 'application/json') {
        let message
        try { message = await readJsonBody(req, 70 * 1024 * 1024) }
        catch (error) { return send(400, { ok: false, error: error.message }) }
        if (message?.protocol !== protocolVersion) {
          return send(409, { ok: false, error: 'webbridge protocol mismatch', expected: protocolVersion })
        }
        lastNativeActivityAt = Date.now()
        const cmdId = String(message.cmdId)
        const pending = results.get(cmdId)
        results.delete(cmdId)
        if (pending) {
          clearTimeout(pending.timer)
          const result = message.result || { ok: false, error: 'empty result' }
          const resultTabId = result?.data?.tabId ?? result?.tabId
          const commandTabId = pending.command?.tabId
          const tabId = Number(resultTabId ?? commandTabId)
          if (Number.isFinite(tabId)) {
            recentOperation = {
              operationId: String(pending.command?.operationId || cmdId),
              label: 'Chrome操作中',
              cmdId,
              kind: String(pending.command?.kind || ''),
              tabId,
              startedAt: Number(pending.startedAt || Date.now()),
              updatedAt: Date.now(),
              visibleUntil: Date.now() + RECENT_OPERATION_GRACE_MS,
            }
          }
          pending.resolve(result)
        } else console.warn('[dsh-webbridge] result for unknown cmdId ' + cmdId)
        return send(200, { ok: true })
      }
      if ((op === 'next' || op === 'result' || op === 'command' || op === 'operation' || op === 'activate') && req.method === 'GET') {
        return send(405, { ok: false, error: 'webbridge control endpoints require POST application/json' })
      }
      if ((op === 'next' || op === 'result' || op === 'command' || op === 'operation' || op === 'activate') && req.method === 'POST') {
        return send(415, { ok: false, error: 'webbridge control endpoints require application/json' })
      }
      if (req.method === 'GET' && op === 'status') {
        const now = Date.now()
        const operation = operationSnapshot(now)
        send(200, {
          ok: true,
          protocol: protocolVersion,
          transport: 'native-messaging',
          controlPlane: 'post-json',
          queued: queue.length,
          pendingResults: results.size,
          nativeHostConnected: lastNativeActivityAt !== null && now - lastNativeActivityAt < 60000,
          chromeOperating: operation !== null,
          operation,
          lastNativeActivityAt,
          fetchedAt: now,
        })
        return
      }
      send(404, { ok: false, error: 'unknown op ' + op })
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'dsh-webbridge: /api/webbridge')
}

function executeCommand(cmd, timeoutMs) {
  return new Promise((resolve) => {
    const cmdId = 'w' + (++seq) + '-' + Date.now().toString(36)
    const startedAt = Date.now()
    touchOperation(cmd, startedAt)
    const timer = setTimeout(() => {
      if (results.has(cmdId)) {
        results.delete(cmdId)
        resolve({ ok: false, error: 'timeout: 扩展未响应(检查 Chrome 已加载扩展且保持运行)' })
      }
    }, timeoutMs || 45000)
    results.set(cmdId, { resolve, timer, command: cmd, startedAt })
    const waiter = waiters.shift()
    if (waiter) waiter({ cmdId, ...cmd })
    else queue.push({ cmdId, ...cmd })
  })
}

export function apply(ctx) {
  registerRoutes(ctx)

  const output = {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        error: { type: 'string' },
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: JSON.stringify(value || {}, null, 2).slice(0, 16000),
    }],
  }

  const tools = [
    {
      name: 'webbridge_status',
      description: '查看 CyberMarcus 浏览器桥状态：扩展是否连接、指定或当前活动标签页的 URL 与标题。',
      parameters: schemaOf({ tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' } }),
      async run(args) {
        return await executeCommand({ kind: 'status', tabId: args.tabId }, 8000)
      },
    },
    {
      name: 'webbridge_list_tabs',
      description: '列出 Chrome 顶层标签页，返回 tabId/windowId/url/title/active，供后续精确控制。',
      parameters: schemaOf({}),
      async run() {
        return await executeCommand({ kind: 'list_tabs' }, 8000)
      },
    },
    {
      name: 'webbridge_open_tab',
      description: '在用户 Chrome 新建一个由本任务持有的标签页，默认后台打开，返回 tabId。',
      parameters: schemaOf({
        url: { type: 'string', description: '初始 URL' },
        active: { type: 'boolean', description: '是否激活标签页，默认 false' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'open_tab', url: args.url, active: args.active }, 65000)
      },
    },
    {
      name: 'webbridge_close_tab',
      description: '关闭由任务持有的指定 Chrome 标签页；必须提供 tabId。',
      parameters: schemaOf({ tabId: { type: 'integer', description: 'Chrome 标签页 ID' } }),
      async run(args) {
        return await executeCommand({ kind: 'close_tab', tabId: args.tabId }, 8000)
      },
    },
    {
      name: 'webbridge_activate_tab',
      description: '激活指定 Chrome 标签页，仅在需要用户查看或截取可见区域时使用。',
      parameters: schemaOf({ tabId: { type: 'integer', description: 'Chrome 标签页 ID' } }),
      async run(args) {
        return await executeCommand({ kind: 'activate_tab', tabId: args.tabId }, 8000)
      },
    },
    {
      name: 'webbridge_navigate',
      description: '在用户当前活动标签页导航到指定 URL，等待页面加载完成。继承用户真实登录态（公众号后台/小红书创作中心等）。',
      parameters: schemaOf({
        url: { type: 'string', description: '目标网址' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'navigate', url: args.url, tabId: args.tabId })
      },
    },
    {
      name: 'webbridge_read',
      description: '读取当前活动标签页文本：url/title/body 文字。limit 为最大字符数(默认6000)。适合读取已登录后台页面内容。',
      parameters: schemaOf({
        limit: { type: 'integer', description: '最大返回字符数' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'read', limit: args.limit, tabId: args.tabId })
      },
    },
    {
      name: 'webbridge_click',
      description: '点击当前活动标签页元素。css 选择器或可见文字(text,nth=第几处)二选一；模拟真实鼠标事件序列(press/move/up/click)。',
      parameters: schemaOf({
        css: { type: 'string', description: 'CSS 选择器(可选)' },
        text: { type: 'string', description: '可见文字定位(可选)' },
        nth: { type: 'integer', description: '同文字多处时的序号,从1起' },
        settleMs: { type: 'integer', description: '点击后等待毫秒,默认400' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
        allFrames: { type: 'boolean', description: '顶层未找到时是否搜索 iframe' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'click', css: args.css, text: args.text, nth: args.nth, settleMs: args.settleMs, tabId: args.tabId, allFrames: args.allFrames })
      },
    },
    {
      name: 'webbridge_trusted_click',
      description: '通过 Chrome debugger 发送可信鼠标点击；用于发布按钮等拒绝合成事件的控件，css/text/坐标三选一。',
      parameters: schemaOf({
        css: { type: 'string', description: 'CSS 选择器(可穿透 open shadow root)' },
        text: { type: 'string', description: '可见文字定位' },
        nth: { type: 'integer', description: '同文字多处时的序号,从1起' },
        x: { type: 'number', description: '可选视口横坐标' },
        y: { type: 'number', description: '可选视口纵坐标' },
        xRatio: { type: 'number', description: '元素内横向点击比例，0-1，默认0.5' },
        yRatio: { type: 'number', description: '元素内纵向点击比例，0-1，默认0.5' },
        settleMs: { type: 'integer', description: '点击后等待毫秒,默认400' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
        allFrames: { type: 'boolean', description: '顶层未找到时是否搜索 iframe' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'trusted_click', css: args.css, text: args.text, nth: args.nth, x: args.x, y: args.y, xRatio: args.xRatio, yRatio: args.yRatio, settleMs: args.settleMs, tabId: args.tabId, allFrames: args.allFrames })
      },
    },
    {
      name: 'webbridge_type',
      description: '向当前活动标签页元素输入文字。css 缺省时输入焦点元素；React/Vue 受控组件可感知(input/change 事件)。公众号编辑器请先点进正文框再省略 css。',
      parameters: schemaOf({
        text: { type: 'string', description: '要输入的文字' },
        css: { type: 'string', description: 'CSS 选择器(可选,缺省用焦点元素)' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
        replace: { type: 'boolean', description: '是否替换现有内容，默认 true' },
        allFrames: { type: 'boolean', description: '顶层未找到时是否搜索 iframe' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'type', text: args.text, css: args.css, tabId: args.tabId, replace: args.replace, allFrames: args.allFrames })
      },
    },
    {
      name: 'webbridge_trusted_key',
      description: '通过 Chrome debugger 发送可信按键或组合键，如 Enter、Backspace、ControlOrMeta+v。',
      parameters: schemaOf({
        key: { type: 'string', description: '按键或组合键' },
        settleMs: { type: 'integer', description: '按键后等待毫秒' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'trusted_key', key: args.key, settleMs: args.settleMs, tabId: args.tabId })
      },
    },
    {
      name: 'webbridge_trusted_insert_text',
      description: '向已聚焦控件发送 Chrome Input.insertText 可信文本输入。',
      parameters: schemaOf({
        text: { type: 'string', description: '输入文字' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'trusted_insert_text', text: args.text, tabId: args.tabId })
      },
    },
    {
      name: 'webbridge_screenshot',
      description: '截取用户浏览器当前可见区域为 PNG 文件,返回本地路径,供视觉核对。',
      parameters: schemaOf({
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
        css: { type: 'string', description: '可选元素选择器，提供时只截元素' },
        text: { type: 'string', description: '可选文字定位，提供时只截元素' },
        allFrames: { type: 'boolean', description: '是否搜索 iframe' },
      }),
      async run(args) {
        const r = await executeCommand({ kind: 'screenshot', tabId: args.tabId, css: args.css, text: args.text, allFrames: args.allFrames })
        if (!r.ok || !r.dataUrl) return r
        try {
          const b64 = String(r.dataUrl).split(',')[1]
          const dir = '/tmp/cm-webbridge'
          fs.mkdirSync(dir, { recursive: true })
          const file = dir + '/' + Date.now() + '.png'
          fs.writeFileSync(file, Buffer.from(b64, 'base64'))
          return { ok: true, path: file }
        } catch (e) {
          return { ok: false, error: String(e) }
        }
      },
    },
    {
      name: 'webbridge_hover',
      description: '悬停在当前活动标签页元素上(css 或 text 定位),用于展开下拉菜单/悬浮操作组件。settleMs 控制悬停后等待。',
      parameters: schemaOf({
        css: { type: 'string', description: 'CSS 选择器(可选)' },
        text: { type: 'string', description: '可见文字定位(可选)' },
        nth: { type: 'integer', description: '同文字多处时的序号' },
        settleMs: { type: 'integer', description: '悬停后等待毫秒,默认500' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'hover', css: args.css, text: args.text, nth: args.nth, settleMs: args.settleMs, tabId: args.tabId })
      },
    },
    {
      name: 'webbridge_press',
      description: '在焦点元素(或 css 指定元素)上发送按键:enter/esc/tab/arrow 等;Enter 会尝试表单提交。',
      parameters: schemaOf({
        key: { type: 'string', description: '键名,如 enter、esc、tab' },
        css: { type: 'string', description: '可选目标选择器' },
        settleMs: { type: 'integer', description: '按键后等待毫秒' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'key', key: args.key, css: args.css, settleMs: args.settleMs, tabId: args.tabId })
      },
    },
    {
      name: 'webbridge_wait',
      description: '等待当前页出现指定文本或元素(css / text 二选一),最长 seconds 秒。SPA 渲染稳定性首选。',
      parameters: schemaOf({
        css: { type: 'string', description: '等待出现的元素选择器' },
        text: { type: 'string', description: '等待出现的页面文字' },
        seconds: { type: 'integer', description: '最长等待秒数,默认15,上限60' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'wait', css: args.css, text: args.text, seconds: args.seconds, tabId: args.tabId }, (args.seconds || 20) * 1000 + 15000)
      },
    },
    {
      name: 'webbridge_scroll',
      description: '滚动当前标签页:css 元素进入视野 / px 像素位移 / to=top|bottom。',
      parameters: schemaOf({
        px: { type: 'integer', description: '相对滚动像素' },
        to: { type: 'string', description: '"top" 或 "bottom"' },
        css: { type: 'string', description: '滚动到该元素' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'scroll', px: args.px, to: args.to, css: args.css, tabId: args.tabId })
      },
    },
    {
      name: 'webbridge_upload_file',
      description: '把本机文件填入当前页面文件输入框并触发 change(公众号封面图等)。仅支持 ≤25MB;需提供 input[type=file] 的 css(缺省自动找第一个)。',
      parameters: schemaOf({
        path: { type: 'string', description: '本机文件绝对路径' },
        css: { type: 'string', description: 'file input 选择器(可选)' },
        mime: { type: 'string', description: 'MIME 类型,默认按扩展名推断' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
      }),
      async run(args) {
        let buf
        try { buf = fs.readFileSync(args.path) } catch (e) { return { ok: false, error: '读取失败: ' + String(e.message || e) } }
        if (buf.length > 25 * 1024 * 1024) return { ok: false, error: '文件超过 25MB 上限' }
        const extension = path.extname(String(args.path)).toLowerCase()
        const mime = args.mime || ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[extension] || 'application/octet-stream')
        return await executeCommand({
          kind: 'upload',
          css: args.css,
          base64: buf.toString('base64'),
          name: String(args.path).split('/').pop(),
          mime,
          tabId: args.tabId,
        }, 60000)
      },
    },
    {
      name: 'webbridge_paste_html',
      description: '向聚焦的富文本编辑器(contenteditable,如公众号正文框)插入 HTML 片段并触发 input。先 click 编辑器再省略 css 调用;不传 css 自动找第一个编辑器。',
      parameters: schemaOf({
        html: { type: 'string', description: '要粘贴的 HTML 片段' },
        css: { type: 'string', description: '编辑器选择器(可选)' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'paste_html', html: args.html, css: args.css, tabId: args.tabId })
      },
    },
    {
      name: 'webbridge_clipboard_html',
      description: '把 HTML 与纯文本写入 Chrome 剪贴板；随后用 webbridge_trusted_key 发送 ControlOrMeta+v。',
      parameters: schemaOf({
        html: { type: 'string', description: 'HTML 内容' },
        text: { type: 'string', description: '可选纯文本内容' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'clipboard_html', html: args.html, text: args.text, tabId: args.tabId }, 90000)
      },
    },
    {
      name: 'webbridge_eval',
      description: '在用户当前活动标签页执行一段 JavaScript 并返回 JSON 可序列化结果。强大但谨慎使用,优先用上面的结构化工具。',
      parameters: schemaOf({
        code: { type: 'string', description: '函数体代码,return 返回结果' },
        tabId: { type: 'integer', description: '可选 Chrome 标签页 ID' },
      }),
      async run(args) {
        return await executeCommand({ kind: 'eval', code: args.code, tabId: args.tabId })
      },
    },
  ]

  for (const t of tools) {
    const { run, ...definition } = t
    ctx.effect(() => ctx.tools.register({ ...definition, output, execute: run }), 'dsh-webbridge: tool ' + t.name)
  }
}

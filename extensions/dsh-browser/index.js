// dsh-browser — Host half: Playwright 浏览器工具集
// 随 profile 加载,注册 6 个工具:
//   browser_open / browser_act / browser_screenshot / browser_text / browser_pdf / browser_close
// 截图通过 attachments 服务以图片块呈现(模型支持视觉时直接可见),并可选保存到磁盘;
// 页面正文经 browser_text 提取,保证无视觉模型时也能"阅读"页面。
import { writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { chromium } from 'playwright'

export const name = 'dsh-browser'
export const inject = ['tools', 'fs']

// ── 进程级浏览器单例(所有会话共享,串行访问) ──
let browserPromise = null
let pagePromise = null
let queue = Promise.resolve()

function serial(fn) {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

async function ensurePage(viewport) {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true })
  }
  const browser = await browserPromise
  if (!pagePromise) {
    const page = await browser.newPage()
    if (viewport) await page.setViewportSize({ width: viewport.width, height: viewport.height })
    pagePromise = Promise.resolve(page)
  } else if (viewport) {
    const page = await pagePromise
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
  }
  return pagePromise
}

async function closeBrowser() {
  const b = browserPromise
  browserPromise = null
  pagePromise = null
  if (b) {
    try { await (await b).close() } catch { /* 已关闭 */ }
  }
}

// ── 截图 → attachments 图片引用 + 可选落盘 ──
async function capture(ctx, page, { fullPage = false, savePath = null, name = 'screenshot.png' } = {}) {
  const data = await page.screenshot({ type: 'png', fullPage })
  let ref = null
  const attachments = ctx.get('attachments')
  if (attachments) {
    try {
      ref = await attachments.saveImage({ data, mediaType: 'image/png', name })
    } catch (e) {
      ref = null
    }
  }
  let savedPath = null
  if (savePath) {
    const target = await ctx.fs.resolve(savePath)
    savedPath = target.displayPath
    await writeFile(savedPath, data)
  }
  return { ref, savedPath }
}

function imageValue(ref, savedPath) {
  const value = {}
  if (ref) {
    value.image = {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name !== void 0 ? { name: ref.name } : {}),
    }
  }
  if (savedPath) value.savedPath = savedPath
  return value
}

function imageBlocks(ref, envelopeText) {
  const blocks = [{ type: 'text', text: envelopeText }]
  if (ref) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
      },
    })
  }
  return blocks
}

async function pageText(page, maxChars = 20000) {
  const text = await page.evaluate(() => (document.body ? document.body.innerText : ''))
  return text.length > maxChars ? text.slice(0, maxChars) + `\n…(已截断, 全文共 ${text.length} 字符)` : text
}

async function gotoUrl(page, url, waitUntil, timeoutMs) {
  await page.goto(url, { waitUntil: waitUntil || 'load', timeout: timeoutMs || 30000 })
}

// 统一的结果封装: 当前 URL/标题 + 正文摘要 + 截图
async function snapshot(ctx, page, { fullPage = false, savePath = null, maxText = 20000 } = {}) {
  const { ref, savedPath } = await capture(ctx, page, { fullPage, savePath })
  const title = await page.title()
  const text = await pageText(page, maxText)
  const url = page.url()
  const value = { url, title, text, ...imageValue(ref, savedPath) }
  const dims = ref ? `${ref.width}x${ref.height}` : 'n/a'
  const envelope = `<url>${url}</url>\n<title>${title}</title>\n<screenshot>${dims} png${savedPath ? ' → ' + savedPath : ''}</screenshot>\n<content>\n${text.slice(0, 1200)}\n</content>`
  return { value, blocks: imageBlocks(ref, envelope) }
}

function deferImage(exec, blocks) {
  if (exec && exec.parent !== void 0 && exec.deferContext) {
    exec.deferContext(createUserMessage({ content: blocks, source: { kind: 'plugin', plugin: 'dsh-browser' } }))
  }
}

const IMAGE_PROPS = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}

const SNAPSHOT_SCHEMA = (withImage = true) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
    text: { type: 'string', required: true },
    ...(withImage ? { image: IMAGE_PROPS } : {}),
    savedPath: { type: 'string' },
  },
})

const COMMON_PARAMS = {
  fullPage: { type: 'boolean', description: '截图整页(默认 false,仅视口)' },
  savePath: { type: 'string', description: '可选: 同时把截图 PNG 保存到该路径(如 截图/xxx.png)' },
}

export function apply(ctx) {
  const { tools } = ctx

  // ── browser_open ──
  tools.register(defineTool({
    name: 'browser_open',
    description: '打开一个 URL(支持 http/https/file 本地 HTML)并返回页面截图与正文摘要。浏览器会话在多次调用间保持,适合页面 QA、查看网页、给本地 HTML 截图。',
    parameters: {
      url: { type: 'string', required: true, description: '要打开的 URL,如 https://example.com 或 file:///path/a.html' },
      waitUntil: { type: 'string', description: "等待策略: 'load'(默认)或 'networkidle'" },
      timeoutMs: { type: 'number', description: '导航超时毫秒(默认 30000)' },
      viewport: {
        type: 'object',
        additionalProperties: false,
        properties: {
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      ...COMMON_PARAMS,
    },
    output: {
      schema: SNAPSHOT_SCHEMA(true),
      render: (_args, value) => value.image ? [
        { type: 'text', text: `<url>${value.url}</url>\n<title>${value.title}</title>\n<content>\n${value.text.slice(0, 2000)}\n</content>` },
        { type: 'image', attachment: value.image },
      ] : [{ type: 'text', text: `<url>${value.url}</url>\n<title>${value.title}</title>\n<content>\n${value.text.slice(0, 2000)}\n</content>` }],
    },
    timeoutMs: 120000,
    async execute(args, exec) {
      return serial(async () => {
        const page = await ensurePage(args.viewport)
        await gotoUrl(page, args.url, args.waitUntil, args.timeoutMs)
        const { value, blocks } = await snapshot(ctx, page, { fullPage: args.fullPage, savePath: args.savePath })
        deferImage(exec, blocks)
        return value
      })
    },
    presentCall(args) {
      return { card: 'generic', title: `Open ${args.url}` }
    },
  }))

  // ── browser_act ──
  tools.register(defineTool({
    name: 'browser_act',
    description: '对当前浏览器页面执行操作: click(点击, selector 支持 CSS 或 text=文本)、type(输入文本)、press(按键如 Enter)、scroll(滚动)、wait(等待)、back/forward/reload(导航)。操作后返回截图与正文摘要。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['click', 'type', 'press', 'scroll', 'wait', 'back', 'forward', 'reload'],
        description: '要执行的操作',
      },
      selector: { type: 'string', description: 'click/type 的目标: CSS 选择器,或以 text= 开头的可见文本' },
      text: { type: 'string', description: 'type 操作要输入的文本' },
      key: { type: 'string', description: 'press 操作的按键,如 Enter、Tab、Escape' },
      amount: { type: 'number', description: 'scroll 操作的像素数(正数向下)' },
      ms: { type: 'number', description: 'wait 操作的毫秒数(默认 1000)' },
      timeoutMs: { type: 'number', description: '操作超时毫秒(默认 10000)' },
      ...COMMON_PARAMS,
    },
    output: {
      schema: SNAPSHOT_SCHEMA(true),
      render: (_args, value) => value.image ? [
        { type: 'text', text: `<url>${value.url}</url>\n<title>${value.title}</title>\n<content>\n${value.text.slice(0, 2000)}\n</content>` },
        { type: 'image', attachment: value.image },
      ] : [{ type: 'text', text: `<url>${value.url}</url>\n<title>${value.title}</title>\n<content>\n${value.text.slice(0, 2000)}\n</content>` }],
    },
    timeoutMs: 120000,
    async execute(args, exec) {
      return serial(async () => {
        const page = await ensurePage()
        const timeout = args.timeoutMs || 10000
        switch (args.action) {
          case 'click': {
            if (!args.selector) throw new Error('click 需要 selector')
            if (args.selector.startsWith('text=')) {
              await page.getByText(args.selector.slice(5)).first().click({ timeout })
            } else {
              await page.click(args.selector, { timeout })
            }
            break
          }
          case 'type': {
            if (!args.selector || args.text === void 0) throw new Error('type 需要 selector 和 text')
            if (args.selector.startsWith('text=')) {
              await page.getByText(args.selector.slice(5)).first().click({ timeout })
              await page.keyboard.type(args.text, { delay: 20 })
            } else {
              try {
                await page.fill(args.selector, args.text, { timeout })
              } catch {
                await page.click(args.selector, { timeout })
                await page.keyboard.type(args.text, { delay: 20 })
              }
            }
            break
          }
          case 'press': {
            if (!args.key) throw new Error('press 需要 key')
            await page.keyboard.press(args.key)
            break
          }
          case 'scroll':
            await page.mouse.wheel(0, args.amount || 400)
            break
          case 'wait':
            await page.waitForTimeout(args.ms || 1000)
            break
          case 'back':
            await page.goBack({ timeout })
            break
          case 'forward':
            await page.goForward({ timeout })
            break
          case 'reload':
            await page.reload({ timeout })
            break
          default:
            throw new Error('未知 action: ' + args.action)
        }
        const { value, blocks } = await snapshot(ctx, page, { fullPage: args.fullPage, savePath: args.savePath })
        deferImage(exec, blocks)
        return value
      })
    },
    presentCall(args) {
      return { card: 'generic', title: `Browser ${args.action}` }
    },
  }))

  // ── browser_screenshot ──
  tools.register(defineTool({
    name: 'browser_screenshot',
    description: '对当前浏览器页面截图(不导航)。返回图片,可指定 fullPage 整页截图与 savePath 保存文件。',
    parameters: { ...COMMON_PARAMS },
    output: {
      schema: SNAPSHOT_SCHEMA(true),
      render: (_args, value) => value.image ? [
        { type: 'text', text: `<url>${value.url}</url>\n<title>${value.title}</title>\n<content>\n${value.text.slice(0, 1200)}\n</content>` },
        { type: 'image', attachment: value.image },
      ] : [{ type: 'text', text: `<url>${value.url}</url>\n<title>${value.title}</title>` }],
    },
    timeoutMs: 60000,
    async execute(args, exec) {
      return serial(async () => {
        const page = await ensurePage()
        const { value, blocks } = await snapshot(ctx, page, { fullPage: args.fullPage, savePath: args.savePath })
        deferImage(exec, blocks)
        return value
      })
    },
    presentCall() {
      return { card: 'generic', title: 'Browser screenshot' }
    },
  }))

  // ── browser_text ──
  tools.register(defineTool({
    name: 'browser_text',
    description: '提取当前浏览器页面的可见正文文本(不截图,省 token)。可传 url 先导航再提取。适合无视觉模型时阅读页面内容。',
    parameters: {
      url: { type: 'string', description: '可选: 先导航到该 URL 再提取' },
      waitUntil: { type: 'string', description: "等待策略: 'load'(默认)或 'networkidle'" },
      timeoutMs: { type: 'number', description: '导航超时毫秒(默认 30000)' },
      maxChars: { type: 'number', description: '返回文本最大字符数(默认 20000)' },
    },
    output: {
      schema: SNAPSHOT_SCHEMA(false),
      render: (_args, value) => [{ type: 'text', text: `<url>${value.url}</url>\n<title>${value.title}</title>\n<content>\n${value.text}\n</content>` }],
    },
    timeoutMs: 60000,
    async execute(args) {
      return serial(async () => {
        const page = await ensurePage()
        if (args.url) await gotoUrl(page, args.url, args.waitUntil, args.timeoutMs)
        const title = await page.title()
        const text = await pageText(page, args.maxChars || 20000)
        return { url: page.url(), title, text }
      })
    },
    presentCall(args) {
      return { card: 'generic', title: `Page text ${args.url || ''}`.trim() }
    },
  }))

  // ── browser_pdf ──
  tools.register(defineTool({
    name: 'browser_pdf',
    description: '把当前页面(或指定 url)导出为 PDF 保存到 path。适用于把网页/本地 HTML 报告导出为 A4 PDF。',
    parameters: {
      path: { type: 'string', required: true, description: 'PDF 保存路径(如 报告.pdf)' },
      url: { type: 'string', description: '可选: 先导航到该 URL 再导出' },
      format: { type: 'string', description: "纸张格式(默认 'A4')" },
      landscape: { type: 'boolean', description: '横向(默认 false)' },
      waitUntil: { type: 'string', description: "等待策略: 'load'(默认)或 'networkidle'" },
      timeoutMs: { type: 'number', description: '导航超时毫秒(默认 30000)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          url: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `<path>${value.path}</path>\n<bytes>${value.bytes}</bytes>\n<url>${value.url}</url>` }],
    },
    timeoutMs: 120000,
    async execute(args) {
      return serial(async () => {
        const page = await ensurePage()
        if (args.url) await gotoUrl(page, args.url, args.waitUntil, args.timeoutMs)
        const target = await ctx.fs.resolve(args.path)
        await page.pdf({
          path: target.displayPath,
          format: args.format || 'A4',
          printBackground: true,
          landscape: !!args.landscape,
        })
        const { stat } = await import('node:fs/promises')
        const info = await stat(target.displayPath)
        return { path: target.displayPath, bytes: info.size, url: page.url() }
      })
    },
    presentCall(args) {
      return { card: 'generic', title: `Export PDF → ${args.path}` }
    },
  }))

  // ── browser_close ──
  tools.register(defineTool({
    name: 'browser_close',
    description: '关闭浏览器会话并释放进程。下次 browser_open 会重新启动。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { closed: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.closed ? '浏览器已关闭' : '浏览器未在运行' }],
    },
    timeoutMs: 15000,
    async execute() {
      return serial(async () => {
        const wasOpen = browserPromise !== null
        await closeBrowser()
        return { closed: wasOpen }
      })
    },
    presentCall() {
      return { card: 'generic', title: 'Close browser' }
    },
  }))
}

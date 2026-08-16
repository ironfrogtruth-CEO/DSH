// dsh-screen — Host half: Computer Use 最小闭环(截图 + OCR + 点击 + 输入)
// 依赖:
//   /usr/sbin/screencapture   — 系统截图(需"屏幕录制"权限)
//   bin/screenutil            — Swift 编译的 OCR/点击/输入工具(需"辅助功能"权限)
// 权限: 系统设置 → 隐私与安全性 → 屏幕录制 / 辅助功能 → 勾选启动服务的终端或大神.app
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-screen'
export const inject = ['tools', 'subprocess']

const SCREENCAPTURE = '/usr/sbin/screencapture'
const SCREENUTIL = '/Users/marcus/.dsh/extensions/dsh-screen/bin/screenutil'

async function run(ctx, argv, opts = {}) {
  const spec = {
    argv,
    cwd: opts.cwd || '/',
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 16 * 1024 * 1024 },
      stderr: { maxBytes: 1024 * 1024 },
    },
    graceMs: opts.graceMs || 30000,
    ...(opts.env ? { env: opts.env } : {}),
  }
  const proc = ctx.subprocess.spawn(spec)
  const outcome = await proc.done
  const collected = proc.collected
  const out = collected && collected.stdout ? collected.stdout.readFrom(0).text : ''
  const err = collected && collected.stderr ? collected.stderr.readFrom(0).text : ''
  return { code: outcome.exitCode, stdout: out, stderr: err }
}

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function capture(ctx, path, region) {
  const argv = ['-x']
  if (region) argv.push('-R', region)
  argv.push(path)
  return run(ctx, [SCREENCAPTURE, ...argv], { graceMs: 20000 })
}

async function ocrFile(ctx, path) {
  const r = await run(ctx, [SCREENUTIL, 'ocr', path], { graceMs: 60000 })
  if (r.code !== 0) return { rows: [], error: (r.stderr || r.stdout || 'OCR 失败').slice(0, 300) }
  try {
    const rows = JSON.parse(r.stdout)
    return { rows, error: null }
  } catch (e) {
    return { rows: [], error: 'OCR 解析失败: ' + r.stdout.slice(0, 200) }
  }
}

export function apply(ctx) {
  const { tools } = ctx

  tools.register(defineTool({
    name: 'screen_shot',
    description: '截取 macOS 屏幕(可指定区域)并返回 OCR 识别文本(带坐标)。用于"看屏幕"——无视觉模型时通过 OCR 了解屏幕内容,再配合 screen_click 操作。截图文件会保存,可直接查看。',
    parameters: {
      path: { type: 'string', description: '截图保存路径(默认 ~/Desktop/屏幕截图-时间戳.png)' },
      region: { type: 'string', description: '区域 "x,y,宽,高"(默认全屏)' },
      ocr: { type: 'boolean', description: '是否 OCR(默认 true)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          ocr: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                x: { type: 'integer', required: true },
                y: { type: 'integer', required: true },
                w: { type: 'integer', required: true },
                h: { type: 'integer', required: true },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return [{ type: 'text', text: `<path>${value.path}</path>\n<error>${value.error}</error>` }]
        const lines = (value.ocr || []).map((r) => `(${r.x},${r.y}) ${r.text}`).join('\n')
        return [{ type: 'text', text: `<path>${value.path}</path>\n<ocr>\n${lines}\n</ocr>` }]
      },
    },
    timeoutMs: 90000,
    async execute(args) {
      const path = args.path || join(homedir(), 'Desktop', `屏幕截图-${timestamp()}.png`)
      const cap = await capture(ctx, path, args.region)
      if (cap.code !== 0) {
        return { path, ocr: [], error: (cap.stderr || '截图失败,请检查"屏幕录制"权限').slice(0, 200) }
      }
      if (args.ocr === false) return { path, ocr: [] }
      const { rows, error } = await ocrFile(ctx, path)
      return { path, ocr: rows, ...(error ? { error } : {}) }
    },
    presentCall(args) {
      return { card: 'generic', title: `Screen shot ${args.region || 'full'}` }
    },
  }))

  tools.register(defineTool({
    name: 'screen_ocr',
    description: '对一张图片文件(或先截图)执行本地 OCR,返回带坐标的文本。',
    parameters: {
      path: { type: 'string', description: '图片路径(不填则先截全屏再 OCR)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          ocr: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                x: { type: 'integer', required: true },
                y: { type: 'integer', required: true },
                w: { type: 'integer', required: true },
                h: { type: 'integer', required: true },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return [{ type: 'text', text: `<error>${value.error}</error>` }]
        const lines = (value.ocr || []).map((r) => `(${r.x},${r.y}) ${r.text}`).join('\n')
        return [{ type: 'text', text: `<path>${value.path}</path>\n<ocr>\n${lines}\n</ocr>` }]
      },
    },
    timeoutMs: 90000,
    async execute(args) {
      let path = args.path
      if (!path) {
        path = join(homedir(), 'Desktop', `屏幕截图-${timestamp()}.png`)
        const cap = await capture(ctx, path)
        if (cap.code !== 0) return { path, ocr: [], error: (cap.stderr || '截图失败').slice(0, 200) }
      }
      const { rows, error } = await ocrFile(ctx, path)
      return { path, ocr: rows, ...(error ? { error } : {}) }
    },
    presentCall() {
      return { card: 'generic', title: 'Screen OCR' }
    },
  }))

  tools.register(defineTool({
    name: 'screen_click',
    description: '在屏幕坐标 (x,y) 处鼠标左键点击(需"辅助功能"权限)。坐标来自 screen_shot 的 OCR 结果。',
    parameters: {
      x: { type: 'number', required: true, description: 'X 坐标(屏幕左上角为原点)' },
      y: { type: 'number', required: true, description: 'Y 坐标' },
      double: { type: 'boolean', description: '双击(默认 false)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? `已点击 (${_a.x},${_a.y})` : `点击失败: ${v.error}` }],
    },
    timeoutMs: 30000,
    async execute(args) {
      const r = await run(ctx, [SCREENUTIL, 'click', String(args.x), String(args.y), args.double ? 'double' : ''])
      if (r.code !== 0) return { ok: false, error: (r.stderr || '点击失败,请检查"辅助功能"权限').slice(0, 200) }
      return { ok: true }
    },
    presentCall(args) {
      return { card: 'generic', title: `Click (${args.x},${args.y})` }
    },
  }))

  tools.register(defineTool({
    name: 'screen_type',
    description: '向当前聚焦的应用键入文本(需"辅助功能"权限)。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文本' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? '已输入' : `输入失败: ${v.error}` }],
    },
    timeoutMs: 60000,
    async execute(args) {
      const r = await run(ctx, [SCREENUTIL, 'type', args.text])
      if (r.code !== 0) return { ok: false, error: (r.stderr || '输入失败,请检查"辅助功能"权限').slice(0, 200) }
      return { ok: true }
    },
    presentCall() {
      return { card: 'generic', title: 'Type text' }
    },
  }))

  tools.register(defineTool({
    name: 'screen_key',
    description: '按下一个按键(enter/tab/escape/space/up/down/left/right/backspace/delete/home/end/pageup/pagedown/a/c/v/x/z/y)。',
    parameters: {
      key: { type: 'string', required: true, description: '按键名' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? `已按键 ${_a.key}` : `按键失败: ${v.error}` }],
    },
    timeoutMs: 30000,
    async execute(args) {
      const r = await run(ctx, [SCREENUTIL, 'key', args.key])
      if (r.code !== 0) return { ok: false, error: (r.stderr || '按键失败').slice(0, 200) }
      return { ok: true }
    },
    presentCall(args) {
      return { card: 'generic', title: `Key ${args.key}` }
    },
  }))
}

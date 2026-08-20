#!/usr/bin/env node
/**
 * zhipu-mcp —— 智谱开放平台免费模型 MCP 服务器（纯 Node，零依赖）
 *
 * 工具：
 *   vision_read(image, prompt?)   GLM-4.6V-Flash 识图 / 图文问答（官方免费，128K 上下文）
 *   ocr_image(image, language?)   GLM-4.6V-Flash OCR：逐行文字，表格转 Markdown
 *   analyze_chart(image)          GLM-4.6V-Flash 图表解析：类型/坐标轴/图例/数据趋势
 *   generate_image(prompt, size?, outputPath?)  CogView-3-Flash 生图（官方免费），保存本地
 *   generate_video(prompt, duration?)           CogVideoX-Flash 视频生成（官方免费，最长 10s）
 *
 * 密钥：ZHIPU_API_KEY —— 环境变量 或 ~/.dsh/.credentials.yaml
 *       免费申请：https://open.bigmodel.cn
 *
 * MCP stdio 传输：stdin 逐行 JSON-RPC 2.0，stdout 回响应；日志只写 stderr。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API_BASE = 'https://open.bigmodel.cn/api/paas/v4'
const VERSION = '1.0.0'

/* ---------------- 密钥 ---------------- */

function loadKey() {
  if (process.env.ZHIPU_API_KEY && process.env.ZHIPU_API_KEY.trim()) {
    return process.env.ZHIPU_API_KEY.trim()
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const cred = path.join(home, '.credentials.yaml')
  try {
    const text = fs.readFileSync(cred, 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*ZHIPU_API_KEY\s*:\s*(.+?)\s*$/)
      if (!m) continue
      const v = m[1].replace(/^['"]|['"]$/g, '').trim()
      if (v && !v.startsWith('#')) return v
    }
  } catch { /* 文件不存在则走环境变量 */ }
  return null
}

let cachedKey = null
function getKey() {
  if (!cachedKey) cachedKey = loadKey()
  return cachedKey
}
function keyHint() {
  return '未配置 ZHIPU_API_KEY：请在 ~/.dsh/.credentials.yaml 填写（免费申请 https://open.bigmodel.cn/usercenter/apikeys），或在环境变量 ZHIPU_API_KEY 中设置。'
}

/* ---------------- 智谱 API 调用 ---------------- */

// 视觉模型回退链：主模型限流/繁忙时自动降级（官方免费模型）
const VISION_MODELS = ['glm-4.6v-flash', 'glm-4v-flash', 'glm-4.1v-thinking-flash']

function isTransient(msg) {
  return /1305|访问量过大|繁忙|限流|429|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(String(msg))
}

// 各模型 max_tokens 上限不同：glm-4v-flash 仅 1024，其余放宽
function maxTokensFor(model, requested) {
  const want = requested || 4096
  if (model === 'glm-4v-flash') return Math.min(want, 1024)
  if (model === 'glm-4.1v-thinking-flash') return Math.min(want, 4096)
  return Math.min(want, 8192)
}

export async function chatWithImageDetailed({ imageUrl, prompt, model, maxTokens = 4096, fetchImpl = fetch, apiKey = getKey() }) {
  const key = apiKey
  if (!key) throw new Error(keyHint())
  const models = model ? [model] : VISION_MODELS
  let lastErr = null
  for (const m of models) {
    try {
      const resp = await fetchImpl(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({
          model: m,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageUrl } },
              { type: 'text', text: prompt },
            ],
          }],
          temperature: 0.2,
          max_tokens: maxTokensFor(m, maxTokens),
        }),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`
        if (isTransient(msg) || resp.status === 429 || resp.status >= 500) {
          lastErr = new Error(`${m}: ${msg}`)
          continue // 换下一个模型
        }
        throw new Error(`智谱 API 错误：${msg}`)
      }
      let text = data?.choices?.[0]?.message?.content
      if (!text) throw new Error('智谱 API 未返回内容')
      // 清洗 thinking 模型的思考块
      text = String(text).replace(/<\/?think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*?$/g, '').trim()
      if (!text) throw new Error('智谱 API 返回空内容')
      return { content: text, model: m, provider: 'zhipu-mcp' }
    } catch (e) {
      if (isTransient(e?.message)) {
        lastErr = new Error(`${m}: ${e.message}`)
        continue
      }
      throw e
    }
  }
  throw new Error(`所有视觉模型均不可用（已自动尝试 ${models.join(' → ')}）：${lastErr?.message || '未知错误'}`)
}

async function chatWithImage(options) {
  return (await chatWithImageDetailed(options)).content
}

async function generateImage({ prompt, size = '1024x1024', outputPath }) {
  const key = getKey()
  if (!key) throw new Error(keyHint())
  const sizes = new Set(['1024x1024', '1024x768', '768x1024', '1280x720', '720x1280'])
  if (!sizes.has(size)) throw new Error(`不支持的尺寸 ${size}，可选：${[...sizes].join(' / ')}`)
  const resp = await fetch(`${API_BASE}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'cogview-3-flash', prompt, size, n: 1 }),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`
    throw new Error(`CogView 生图错误：${msg}`)
  }
  const url = data?.data?.[0]?.url
  if (!url) throw new Error('CogView 未返回图片 URL')

  const outDir = outputPath ? path.dirname(path.resolve(outputPath)) : path.join(os.homedir(), '.dsh', 'zhipu-images')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = outputPath
    ? path.resolve(outputPath)
    : path.join(outDir, `cogview_${Date.now()}.png`)

  const imgResp = await fetch(url)
  if (!imgResp.ok) throw new Error(`下载图片失败：HTTP ${imgResp.status}`)
  const buf = Buffer.from(await imgResp.arrayBuffer())
  fs.writeFileSync(outFile, buf)
  return { path: outFile, url, bytes: buf.length, model: 'cogview-3-flash', size }
}

async function generateVideo({ prompt, duration = 5 }) {
  const key = getKey()
  if (!key) throw new Error(keyHint())
  if (![5, 10].includes(Number(duration))) throw new Error('duration 仅支持 5 或 10 秒')
  const resp = await fetch(`${API_BASE}/videos/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'cogvideox-flash', prompt, duration: Number(duration) }),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`
    throw new Error(`CogVideoX 错误：${msg}`)
  }
  const taskId = data?.id
  if (!taskId) throw new Error('CogVideoX 未返回任务 ID')

  // 轮询异步结果（最长 10 分钟）
  const deadline = Date.now() + 10 * 60 * 1000
  let last = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    const r = await fetch(`${API_BASE}/async-result/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` },
    }).catch(() => null)
    if (!r) continue
    const d = await r.json().catch(() => ({}))
    last = d
    if (d?.task_status === 'SUCCESS') {
      const videoUrl = d?.video_result?.[0]?.url || d?.url
      if (!videoUrl) throw new Error(`任务成功但未返回视频 URL：${JSON.stringify(d).slice(0, 500)}`)
      const outDir = path.join(os.homedir(), '.dsh', 'zhipu-videos')
      fs.mkdirSync(outDir, { recursive: true })
      const outFile = path.join(outDir, `cogvideo_${Date.now()}.mp4`)
      const vResp = await fetch(videoUrl)
      if (!vResp.ok) throw new Error(`下载视频失败：HTTP ${vResp.status}`)
      fs.writeFileSync(outFile, Buffer.from(await vResp.arrayBuffer()))
      return { path: outFile, url: videoUrl, model: 'cogvideox-flash', duration: Number(duration) }
    }
    if (d?.task_status === 'FAIL') {
      throw new Error(`CogVideoX 任务失败：${JSON.stringify(d).slice(0, 500)}`)
    }
  }
  throw new Error(`CogVideoX 任务超时（10 分钟），最后状态：${JSON.stringify(last || {}).slice(0, 300)}`)
}

/* ---------------- 图片参数归一化 ---------------- */

async function resolveImage(image, cwd) {
  if (!image || typeof image !== 'string') throw new Error('image 参数缺失（本地路径 / http(s) URL / data URI / base64 均可）')
  const s = image.trim()
  if (s.startsWith('data:')) return s
  if (/^https?:\/\//i.test(s)) return s
  // 本地路径
  const p = path.isAbsolute(s) ? s : path.resolve(cwd || process.cwd(), s)
  try {
    const buf = await fs.promises.readFile(p)
    if (buf.length > 15 * 1024 * 1024) {
      throw new Error(`图片过大（${(buf.length / 1048576).toFixed(1)}MB > 10MB），请压缩后重试`)
    }
    const ext = path.extname(p).toLowerCase()
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`找不到图片文件：${p}`)
    throw e
  }
  // 裸 base64（纯 base64 字符且较长）—— 放在文件尝试之后
  // if (/^[A-Za-z0-9+/=\r\n]{500,}$/.test(s)) return `data:image/png;base64,${s.replace(/\s/g, '')}`
}

/* ---------------- 工具定义 ---------------- */

const tools = [
  {
    name: 'vision_read',
    description: '识图 / 图文问答：用免费视觉模型 GLM-4.6V-Flash 看懂图片并回答关于图片的问题。支持本地路径、URL、data URI、base64。',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '图片：本地文件路径（绝对或相对路径）、http(s) URL、data URI 或 base64' },
        prompt: { type: 'string', description: '关于图片的问题或指令，默认"请详细描述这张图片的内容"' },
      },
      required: ['image'],
    },
  },
  {
    name: 'ocr_image',
    description: '图片 OCR 文字识别：提取图中文字，逐行输出并尽量保留版式；表格自动转为 Markdown 表格。',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '图片：本地路径 / URL / data URI / base64' },
        language: { type: 'string', enum: ['auto', 'zh', 'en'], description: '语言，默认 auto' },
      },
      required: ['image'],
    },
  },
  {
    name: 'analyze_chart',
    description: '图表解析：识别图表类型（折线/柱状/饼图等）、坐标轴、图例、单位，结构化提取数据并总结趋势。',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '图表图片：本地路径 / URL / data URI / base64' },
      },
      required: ['image'],
    },
  },
  {
    name: 'generate_image',
    description: 'AI 生图：用免费模型 CogView-3-Flash 根据文字描述生成图片，保存到本地并返回路径。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '详细的图片描述（中文即可，越具体越好）' },
        size: { type: 'string', enum: ['1024x1024', '1024x768', '768x1024', '1280x720', '720x1280'], description: '尺寸，默认 1024x1024' },
        outputPath: { type: 'string', description: '保存路径（可选），默认 ~/.dsh/zhipu-images/ 下自动命名' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_video',
    description: 'AI 视频生成：用免费模型 CogVideoX-Flash 根据文字描述生成短视频（最长 10 秒），保存到本地返回路径。注意：生成耗时约 1-5 分钟。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频内容描述' },
        duration: { type: 'number', enum: [5, 10], description: '时长秒数，默认 5' },
      },
      required: ['prompt'],
    },
  },
]

async function callTool(name, args) {
  const cwd = process.env.DSH_WORKSPACE || process.cwd()
  switch (name) {
    case 'vision_read': {
      const url = await resolveImage(args?.image, cwd)
      const text = await chatWithImage({ imageUrl: url, prompt: args?.prompt || '请详细描述这张图片的内容' })
      return { content: [{ type: 'text', text }] }
    }
    case 'ocr_image': {
      const url = await resolveImage(args?.image, cwd)
      const lang = args?.language === 'en' ? '输出英文原文' : args?.language === 'zh' ? '输出中文原文' : '按图片实际语言输出'
      const text = await chatWithImage({ imageUrl: url, prompt: `你是 OCR 引擎。提取图片中所有文字：逐行输出、保留版式与换行；表格用 Markdown 表格表示；忽略水印和无关装饰。${lang}。只输出识别结果，不要解释。` })
      return { content: [{ type: 'text', text }] }
    }
    case 'analyze_chart': {
      const url = await resolveImage(args?.image, cwd)
      const text = await chatWithImage({ imageUrl: url, prompt: '你是图表分析师。识别图表类型（折线图/柱状图/饼图/散点图/雷达图等）、坐标轴含义、图例、单位和数据量级，结构化提取关键数据点，最后用 3-5 句话总结趋势与要点。' })
      return { content: [{ type: 'text', text }] }
    }
    case 'generate_image': {
      const out = await generateImage({ prompt: args?.prompt, size: args?.size || '1024x1024', outputPath: args?.outputPath })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    case 'generate_video': {
      const out = await generateVideo({ prompt: args?.prompt, duration: args?.duration || 5 })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
    default:
      throw new Error(`未知工具：${name}`)
  }
}

/* ---------------- MCP stdio 主循环 ---------------- */

export function startMcpServer() {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
  const rl = readline.createInterface({ input: process.stdin })
  let pending = 0
  rl.on('line', async (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return // 忽略非 JSON 行
    }
    const { id, method, params } = msg
    if (!method) return

    pending++
    try {
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'zhipu-mcp', version: VERSION } } })
      } else if (method === 'notifications/initialized' || method === 'initialized') {
        // 无需响应
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} })
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools } })
      } else if (method === 'tools/call') {
        const { name, arguments: args } = params || {}
        try {
          const result = await callTool(name, args)
          send({ jsonrpc: '2.0', id, result })
        } catch (e) {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true } })
        }
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message || e) } })
    } finally {
      pending--
    }
  })

  rl.on('close', () => {
    // 等待进行中的工具调用完成后再退出（避免 stdin EOF 打断长任务）
    const t = setInterval(() => {
      if (pending === 0) {
        clearInterval(t)
        process.exit(0)
      }
    }, 200)
    setTimeout(() => process.exit(0), 60_000).unref?.()
  })
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) startMcpServer()

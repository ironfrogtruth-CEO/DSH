// dsh-memory — Host half: 持久记忆(键值 markdown 库)
// 存储于 ~/.dsh/memories/<key>.md, 可保存/读取/列出/搜索
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-memory'
export const inject = ['tools']

const MEMORY_ROOT = join(homedir(), '.dsh', 'memories')

async function ensureRoot() {
  await mkdir(MEMORY_ROOT, { recursive: true })
}

function sanitizeKey(key) {
  const clean = key.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!clean) throw new Error('key 无效: 需含字母/数字/中文/连字符')
  if (clean.length > 80) throw new Error('key 过长(>80)')
  return clean
}

export function apply(ctx) {
  const { tools } = ctx

  tools.register(defineTool({
    name: 'memory_save',
    description: '保存一条持久记忆到 ~/.dsh/memories/。用于跨会话记住: 用户偏好、项目约定、账号/路径事实、决策记录。同名 key 覆盖。',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键(如 user-profile / shrimptank-conventions)' },
      content: { type: 'string', required: true, description: '记忆内容(markdown)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, path: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? `已保存: ${v.path}` : `失败: ${v.error}` }],
    },
    timeoutMs: 15000,
    async execute(args) {
      try {
        const key = sanitizeKey(args.key)
        await ensureRoot()
        const path = join(MEMORY_ROOT, key + '.md')
        const header = `# ${args.key.trim()}\n\n> 保存于 ${new Date().toISOString()}\n\n`
        await writeFile(path, header + args.content)
        return { ok: true, path }
      } catch (e) {
        return { ok: false, error: String(e.message || e).slice(0, 300) }
      }
    },
    presentCall() {
      return { card: 'generic', title: 'Save memory' }
    },
  }))

  tools.register(defineTool({
    name: 'memory_get',
    description: '读取一条持久记忆。',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, content: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.content : `失败: ${v.error}` }],
    },
    timeoutMs: 15000,
    async execute(args) {
      try {
        const key = sanitizeKey(args.key)
        const path = join(MEMORY_ROOT, key + '.md')
        const content = await readFile(path, 'utf8')
        return { ok: true, content }
      } catch (e) {
        return { ok: false, error: e.code === 'ENOENT' ? `没有找到记忆 "${args.key}"` : String(e.message || e).slice(0, 300) }
      }
    },
    presentCall() {
      return { card: 'generic', title: 'Get memory' }
    },
  }))

  tools.register(defineTool({
    name: 'memory_list',
    description: '列出所有持久记忆键(附首行摘要)。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, memories: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.memories : `失败: ${v.error}` }],
    },
    timeoutMs: 15000,
    async execute() {
      try {
        await ensureRoot()
        const files = (await readdir(MEMORY_ROOT)).filter((f) => f.endsWith('.md')).sort()
        const lines = []
        for (const f of files) {
          try {
            const text = await readFile(join(MEMORY_ROOT, f), 'utf8')
            const first = text.split('\n').find((l) => l.trim() && !l.startsWith('>') && !l.startsWith('#')) || ''
            lines.push(`${f.replace(/\.md$/, '')}: ${first.trim().slice(0, 80)}`)
          } catch { /* 跳过 */ }
        }
        return { ok: true, memories: lines.length ? lines.join('\n') : '(无记忆)' }
      } catch (e) {
        return { ok: false, error: String(e.message || e).slice(0, 300) }
      }
    },
    presentCall() {
      return { card: 'generic', title: 'List memories' }
    },
  }))

  tools.register(defineTool({
    name: 'memory_search',
    description: '在所有持久记忆中搜索关键词,返回匹配的记忆键与命中行。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, results: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? v.results : `失败: ${v.error}` }],
    },
    timeoutMs: 15000,
    async execute(args) {
      try {
        await ensureRoot()
        const q = args.query.toLowerCase()
        const files = (await readdir(MEMORY_ROOT)).filter((f) => f.endsWith('.md'))
        const hits = []
        for (const f of files) {
          try {
            const text = await readFile(join(MEMORY_ROOT, f), 'utf8')
            const lines = text.split('\n')
            for (const l of lines) {
              if (l.toLowerCase().includes(q)) {
                hits.push(`${f.replace(/\.md$/, '')}: ${l.trim().slice(0, 120)}`)
                break
              }
            }
          } catch { /* 跳过 */ }
        }
        return { ok: true, results: hits.length ? hits.join('\n') : `(未找到含 "${args.query}" 的记忆)` }
      } catch (e) {
        return { ok: false, error: String(e.message || e).slice(0, 300) }
      }
    },
    presentCall() {
      return { card: 'generic', title: 'Search memories' }
    },
  }))
}

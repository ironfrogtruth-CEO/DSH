// zhipu-media — Host half(静态 bundle 插件)
// 提供 /zhipu-media/<file> 静态路由:
//   - ~/.dsh/zhipu-images/  智谱 CogView 生图产物
//   - ~/.dsh/zhipu-videos/  智谱 CogVideoX 视频产物
// 供浏览器端 client.js 直接渲染图片卡片(<img src="/zhipu-media/xxx.png">)。
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readFile, realpath } from 'node:fs/promises'

export const name = 'zhipu-media'

export const inject = ['webServer']

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
}

function isInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function defaultLocalRoots() {
  const home = homedir()
  return [
    join(home, '.dsh', 'zhipu-images'),
    join(home, '.dsh', 'zhipu-videos'),
    join(home, 'Desktop'),
  ]
}

function defaultGeneratedRoots() {
  const home = homedir()
  return [join(home, '.dsh', 'zhipu-images'), join(home, '.dsh', 'zhipu-videos')]
}

async function resolveAllowedImage(requested, roots = defaultLocalRoots()) {
  if (!requested || !isAbsolute(requested)) return null
  let target
  try {
    target = await realpath(resolve(requested))
  } catch {
    return null
  }
  for (const root of roots) {
    let resolvedRoot
    try { resolvedRoot = await realpath(root) } catch { continue }
    if (isInside(resolvedRoot, target)) return target
  }
  return null
}

async function resolveGeneratedMedia(name, roots = defaultGeneratedRoots()) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  const mime = MIME[ext]
  if (!mime || (!mime.startsWith('image/') && !mime.startsWith('video/'))) return null
  for (const root of roots) {
    try {
      const resolvedRoot = await realpath(root)
      const target = await realpath(join(root, name))
      if (isInside(resolvedRoot, target)) return { file: target, mime }
    } catch { /* 尝试下一个受管目录 */ }
  }
  return null
}

export function apply(ctx, options = {}) {
  const localRoots = options.localRoots || defaultLocalRoots()
  const generatedRoots = options.generatedRoots || defaultGeneratedRoots()
  const fileRoute = {
    kind: 'exact',
    path: '/zhipu-media/file',
    handler: async (req, res) => {
      const send = (code, body, headers = {}) => {
        res.writeHead(code, headers)
        res.end(body)
      }
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const file = await resolveAllowedImage(url.searchParams.get('path') || '', localRoots)
        if (!file) {
          send(404, 'not found')
          return
        }
        const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
        if (!MIME[ext] || !MIME[ext].startsWith('image/')) {
          send(415, 'unsupported media type')
          return
        }
        const buf = await readFile(file)
        send(200, buf, {
          'Content-Type': MIME[ext],
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        })
      } catch {
        send(500, 'internal media error')
      }
    },
  }
  const route = {
    kind: 'prefix',
    path: '/zhipu-media',
    handler: async (req, res) => {
      const send = (code, body, headers = {}) => {
        res.writeHead(code, headers)
        res.end(body)
      }
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const raw = url.pathname.slice('/zhipu-media/'.length)
        const name = decodeURIComponent(raw)
        const media = await resolveGeneratedMedia(name, generatedRoots)
        if (!media) {
          send(404, 'not found')
          return
        }
        const buf = await readFile(media.file)
        send(200, buf, {
          'Content-Type': media.mime,
          'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        })
      } catch {
        send(500, 'internal media error')
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(fileRoute), 'zhipu-media: authorized local image route')
  ctx.effect(() => ctx.webServer.register(route), 'zhipu-media: /zhipu-media static route')
}

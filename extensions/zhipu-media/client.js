// zhipu-media — Client half(浏览器 ModuleLoader 格式)
// 1) 拖拽上传蒙版移除: 官方 DropOverlay 一旦插入便在绘制前清除,
//    贴图由 shrimp-shell 的无蒙版草稿条接管。
// 2) mcp__zhipu__generate_image 工具卡片: 渲染生成的图片缩略图, 点击放大预览。
// 3) shell.overlay 注册全局 Lightbox(点击遮罩或 ESC 关闭)。
// 4) 已完成 Think / ToolCall 默认隐藏, 在每轮回复尾部点“过程”恢复官方完整记录。
window.__ModuleLoader__.load({
  id: '@local/zhipu-media',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let React = require('react')

    const inject = ['slots']

    /* ---------------- 轻量 lightbox store ---------------- */
    let lightbox = null
    const listeners = new Set()
    let processExpanded = false
    const processListeners = new Set()
    function openLightbox(url, alt) { lightbox = { url, alt }; listeners.forEach((l) => l()) }
    function closeLightbox() { lightbox = null; listeners.forEach((l) => l()) }
    function useLightbox() {
      const [, force] = React.useReducer((x) => x + 1, 0)
      React.useEffect(() => { listeners.add(force); return () => listeners.delete(force) }, [])
      return lightbox
    }
    function setProcessExpanded(value) {
      processExpanded = Boolean(value)
      document.body.dataset.zpmProcess = processExpanded ? 'expanded' : 'compact'
      processListeners.forEach((listener) => listener())
    }
    function useProcessExpanded() {
      const [, force] = React.useReducer((x) => x + 1, 0)
      React.useEffect(() => { processListeners.add(force); return () => processListeners.delete(force) }, [])
      return processExpanded
    }

    /* ---------------- CSS ---------------- */
    const CSS = [
      '.zpm-tool-folder { margin: 4px 0 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.05)); overflow: hidden; }',
      '.zpm-tool-summary { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 12px; border: 0; background: transparent; color: var(--dsw-alias-label-primary, #1f2329); font: 12.5px/1.3 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; cursor: pointer; text-align: left; }',
      '.zpm-tool-summary:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }',
      '.zpm-tool-summary .zpm-caret { transition: transform .15s ease; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 10px; }',
      '.zpm-tool-summary.zpm-open .zpm-caret { transform: rotate(90deg); }',
      '.zpm-tool-count { color: var(--dsw-alias-label-secondary, #747982); }',
      '.zpm-tool-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-left: 4px; min-width: 0; }',
      '.zpm-chip { padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-label-secondary, #747982); font-size: 11px; white-space: nowrap; }',
      '.zpm-chip .zpm-ok { color: #35a56f; } .zpm-chip .zpm-err { color: #e5484d; }',
      '.zpm-tool-list { border-top: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.16)); max-height: 420px; overflow: auto; }',
      '.zpm-tool-list .zpm-expanded-card { padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.12)); }',
      '.zpm-tool-list .zpm-expanded-card:last-child { border-bottom: 0; }',
      '.zpm-tool-row { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 12px; border: 0; background: transparent; color: var(--dsw-alias-label-primary, #1f2329); font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; cursor: pointer; text-align: left; }',
      '.zpm-tool-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); }',
      '.zpm-tool-row .zpm-name { font-weight: 600; white-space: nowrap; }',
      '.zpm-tool-row .zpm-args { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #747982); }',
      '.zpm-tool-row .zpm-state { margin-left: auto; flex: 0 0 auto; }',
      '.zpm-process-toggle { min-height: 28px; display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary, #626870); font: 500 12px/1 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; cursor: pointer; white-space: nowrap; }',
      '.zpm-process-toggle:hover, .zpm-process-toggle[data-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, #1f2329); }',
      'body[data-zpm-process="compact"] [data-variant="think"][data-state="ok"] { display: none !important; }',
      'body[data-zpm-process="compact"] [data-chat-flow-kind="tool-call"]:not(.zpm-running-tool):not(:has(.zpm-gen-image)) { display: none !important; }',
      '.zpm-gen-image { border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22)); border-radius: 12px; padding: 10px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.05)); }',
      '.zpm-gen-image .zpm-img { display: block; max-width: 260px; max-height: 260px; border-radius: 8px; cursor: zoom-in; object-fit: cover; }',
      '.zpm-gen-image .zpm-pending { color: var(--dsw-alias-label-secondary, #747982); font: 12.5px/1.4 ui-sans-serif, sans-serif; }',
      '.zpm-gen-image .zpm-error { color: #e5484d; font: 12.5px/1.4 ui-sans-serif, sans-serif; }',
      '.zpm-assistant-media-card { max-width: min(620px, 78vw); display: block; margin: 8px 0; padding: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22)); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.05)); }',
      '.zpm-assistant-media-grid { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; }',
      '.zpm-assistant-media-trigger { display: block; max-width: min(600px, 74vw); margin: 0; padding: 0; border: 0; border-radius: 10px; overflow: hidden; background: transparent; cursor: zoom-in; }',
      '.zpm-assistant-media-image { display: block; width: auto; max-width: min(580px, 72vw); max-height: min(520px, 62vh); border-radius: 10px; object-fit: contain; background: var(--dsw-alias-bg-base, rgba(128,128,128,.05)); }',
      '.zpm-assistant-media-trigger[data-zpm-media-error="true"] { min-width: 160px; min-height: 84px; cursor: default; }',
      '.zpm-assistant-media-trigger[data-zpm-media-error="true"] .zpm-assistant-media-image { display: none; }',
      '.zpm-assistant-media-error { display: inline-flex; min-width: 160px; min-height: 84px; align-items: center; justify-content: center; padding: 10px 14px; color: var(--dsw-alias-label-tertiary, #747982); font: 12.5px/1.4 ui-sans-serif, sans-serif; }',
      '.zpm-assistant-media-error[hidden] { display: none !important; }',
      '.zpm-assistant-source-hidden { display: none !important; }',
      '.zpm-source-hidden { display: none !important; }',
      '.zpm-user-media-card { max-width: min(560px, 78vw); display: grid; gap: 8px; justify-items: end; }',
      '.zpm-user-media-text { padding: 9px 13px; border-radius: 14px; background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, #1f2329); white-space: pre-wrap; font: 14px/1.55 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }',
      '.zpm-user-media-grid { max-width: 100%; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }',
      '.zpm-user-media-grid button { padding: 0; border: 0; border-radius: 12px; background: transparent; cursor: zoom-in; overflow: hidden; }',
      '.zpm-user-media-grid img { display: block; width: min(240px, 34vw); max-height: 220px; object-fit: cover; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2)); }',
      '.zpm-user-media-details { max-width: 100%; color: var(--dsw-alias-label-tertiary, #747982); font: 12px/1.5 ui-sans-serif, sans-serif; }',
      '.zpm-user-media-details summary { cursor: pointer; text-align: right; }',
      '.zpm-user-media-details p { max-width: 520px; margin: 5px 0 0; padding: 8px 10px; border-radius: 9px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06)); text-align: left; white-space: pre-wrap; }',
      '.zpm-lightbox-close { position: fixed; top: 18px; right: 24px; z-index: 10000; border: 0; background: rgba(255,255,255,.12); color: #fff; width: 34px; height: 34px; border-radius: 50%; font-size: 18px; cursor: pointer; }',
    ].join('\n')

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      setProcessExpanded(false)
      ctx.effect(() => () => { delete document.body.dataset.zpmProcess }, 'zhipu-media: process mode')

      const style = document.createElement('style')
      style.id = 'zhipu-media-styles'
      style.textContent = CSS
      document.getElementById(style.id)?.remove()
      document.head.appendChild(style)
      ctx.effect(() => () => { if (style.isConnected) style.remove() }, 'zhipu-media: styles')

      /* ---------- 1) 蒙版移除 + 用户贴图消息投影 ---------- */
      function scrubDropOverlay() {
        const els = document.querySelectorAll('div[role="status"]')
        for (const el of els) {
          const text = (el.textContent || '')
          if (text.includes('拖动到此处') || text.includes('无法添加图片')) {
            el.remove()
          }
        }
      }
      function enhanceVisionMessages() {
        const flows = document.querySelectorAll('[data-chat-flow-kind="user"]')
        for (const flow of flows) {
          if (flow.querySelector('.zpm-user-media-card')) continue
          const bubble = flow.querySelector('[data-slot="conversation.chat.node"] > div > div > div')
          const raw = bubble && bubble.textContent ? bubble.textContent : ''
          if (!raw.includes('/api/shrimp/vision/media/')) continue
          const media = []
          const re = /!\[([^\]]*)\]\((\/api\/shrimp\/vision\/media\/[^)]+)\)\s*\n\[图片数据摘要[^\]]*\]\s*\n([\s\S]*?)(?=\n\[完整识别记录：|\n!\[|\n\[路由说明：|$)/g
          let match
          while ((match = re.exec(raw)) !== null) {
            media.push({ name: match[1] || '图片', url: match[2], summary: match[3].trim() })
          }
          if (!media.length) continue
          const firstMarker = raw.indexOf('![')
          const userText = (firstMarker >= 0 ? raw.slice(0, firstMarker) : raw).trim()
          const stack = bubble.parentElement
          if (!stack) continue
          const card = document.createElement('div')
          card.className = 'zpm-user-media-card'
          if (userText) {
            const text = document.createElement('div')
            text.className = 'zpm-user-media-text'
            text.textContent = userText
            card.appendChild(text)
          }
          const grid = document.createElement('div')
          grid.className = 'zpm-user-media-grid'
          for (const item of media) {
            const button = document.createElement('button')
            button.type = 'button'
            button.title = '点击放大图片'
            button.setAttribute('aria-label', `放大图片 ${item.name}`)
            const image = document.createElement('img')
            image.src = item.url
            image.alt = item.name
            button.appendChild(image)
            button.addEventListener('click', () => openLightbox(item.url, item.name))
            grid.appendChild(button)
          }
          card.appendChild(grid)
          const details = document.createElement('details')
          details.className = 'zpm-user-media-details'
          const summary = document.createElement('summary')
          summary.textContent = `查看识图摘要（${media.length} 张）`
          details.appendChild(summary)
          for (const item of media) {
            const paragraph = document.createElement('p')
            paragraph.textContent = media.length > 1 ? `${item.name}\n${item.summary}` : item.summary
            details.appendChild(paragraph)
          }
          card.appendChild(details)
          bubble.classList.add('zpm-source-hidden')
          stack.insertBefore(card, bubble)
        }
      }

      /* ---------- 1b) 助手消息图片投影 ----------
       * MarkdownText 对不同版本的 Markdown 图片实现并不完全一致：有时已经
       * 生成 <img>，有时仍是文本（尤其是流式/错误回退消息）。这里在最终 DOM
       * 层只处理助手节点，统一投影成可点击图片卡，并把本地绝对路径换成受限
       * 的 /zhipu-media/file?path= 路由。不会读取文件，也不会触碰用户识图卡。
       */
      const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif)(?:[?#].*)?$/i
      const LOCAL_IMAGE_RE = /^(?:\/(?:Users|private|tmp|var(?:\/folders)?|Volumes|home|opt|workspace|mnt)(?:\/|$)|[A-Za-z]:[\\/])/i
      const MEDIA_SKIP_SELECTOR = '.zpm-assistant-media-card, .zpm-gen-image, .zpm-user-media-card, script, style, textarea, input'
      const MEDIA_TEXT_SKIP_SELECTOR = MEDIA_SKIP_SELECTOR + ', button'

      function decodeMediaText(value) {
        return String(value || '')
          .replace(/\\\//g, '/')
          .replace(/&amp;/gi, '&')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;|&apos;/gi, "'")
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
      }
      function trimMediaToken(value) {
        let text = decodeMediaText(value).trim()
        text = text.replace(/^<|>$/g, '').replace(/^["'`]+|["'`]+$/g, '')
        text = text.replace(/[),.;:!?，。；：！？\]}]+$/g, '')
        return text.trim()
      }
      function isLocalImagePath(value) {
        const path = trimMediaToken(value)
        return LOCAL_IMAGE_RE.test(path) && IMAGE_EXT_RE.test(path)
      }
      function localImageSource(value) {
        const path = trimMediaToken(value)
        if (!isLocalImagePath(path)) return null
        let decoded = path
        try { decoded = decodeURIComponent(path) } catch { /* 保留原始路径 */ }
        return {
          src: '/zhipu-media/file?path=' + encodeURIComponent(decoded),
          local: true,
        }
      }
      function looksLikeImageUrl(value) {
        const url = trimMediaToken(value)
        if (IMAGE_EXT_RE.test(url)) return true
        return /[?&](?:format|fm|type|mime)=(?:image\/)?(?:png|jpe?g|gif|webp|bmp|avif)(?:&|$)/i.test(url) || /\/(?:image|img|media|asset|upload|download)(?:[/?]|$)/i.test(url)
      }
      function normalizeMediaSource(value, options = {}) {
        const text = trimMediaToken(value)
        if (!text) return null
        if (/^\/zhipu-media\/file\?path=/i.test(text)) return { src: text, local: true }
        if (/^data:image\//i.test(text) || /^blob:/i.test(text)) return { src: text }
        if (/^https?:\/\//i.test(text)) {
          if (!options.allowAnyRemote && !looksLikeImageUrl(text)) return null
          return { src: text }
        }
        return localImageSource(text)
      }
      function mediaAlt(value, source) {
        const raw = trimMediaToken(value)
        if (!raw || isLocalImagePath(raw) || /^https?:\/\//i.test(raw)) return '图片'
        return raw.length > 80 ? raw.slice(0, 77) + '…' : raw
      }
      function dedupeMedia(items) {
        const result = []
        const seen = new Map()
        for (const item of items) {
          if (!item || !item.src) continue
          const previous = seen.get(item.src)
          if (previous) {
            if (previous.alt === '图片' && item.alt && item.alt !== '图片') previous.alt = item.alt
            continue
          }
          const copy = { ...item, alt: item.alt || '图片' }
          seen.set(copy.src, copy)
          result.push(copy)
        }
        return result
      }
      function pairLocalFallbacks(items, rawText) {
        const remote = items.find((item) => !item.local && /^https?:\/\//i.test(item.src))
        const local = items.find((item) => item.local)
        if (!remote || !local || !/(?:["']?(?:path|outputPath|filePath|url|image_url|imageUrl)["']?\s*[:=])/i.test(rawText)) return items
        remote.fallbackSrc = local.src
        return items.filter((item) => item !== local)
      }
      function extractTextMedia(text) {
        const source = String(text || '')
        const items = []
        const add = (raw, alt, options = {}) => {
          const media = normalizeMediaSource(raw, options)
          if (!media) return
          items.push({ ...media, alt: mediaAlt(alt, media.src) })
        }
        const markdown = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gi
        let match
        while ((match = markdown.exec(source)) !== null) add(match[2] || match[3], match[1], { allowAnyRemote: true })
        const jsonPath = /"(?:path|outputPath|filePath)"\s*:\s*"((?:\\.|[^"])*)"/gi
        while ((match = jsonPath.exec(source)) !== null) add(match[1], '', { allowAnyRemote: false })
        const jsonUrl = /"(?:url|image_url|imageUrl|src|imageSrc)"\s*:\s*"((?:\\.|[^"])*)"/gi
        while ((match = jsonUrl.exec(source)) !== null) add(match[1], '', { allowAnyRemote: true })
        const localPath = /(?:\/(?:Users|private|tmp|var(?:\/folders)?|Volumes|home|opt|workspace|mnt)\/[^\n"'`<>()[\],;]+?\.(?:png|jpe?g|gif|webp|bmp|avif)(?:[?#][^\n"'`<>()[\],;]*)?)/gi
        while ((match = localPath.exec(source)) !== null) add(match[0], '', { allowAnyRemote: false })
        const remoteUrl = /https?:\/\/[^\s<>"'`\)\]}]+/gi
        while ((match = remoteUrl.exec(source)) !== null) add(match[0], '', { allowAnyRemote: false })
        return pairLocalFallbacks(dedupeMedia(items), source)
      }
      function stripTextMedia(text) {
        let cleaned = String(text || '')
        const markdown = /!\[[^\]]*\]\(\s*(?:<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gi
        cleaned = cleaned.replace(markdown, '')
        const jsonPath = /"(?:path|outputPath|filePath)"\s*:\s*"((?:\\.|[^"])*)"/gi
        cleaned = cleaned.replace(jsonPath, (whole, raw) => normalizeMediaSource(raw) ? '' : whole)
        const jsonUrl = /"(?:url|image_url|imageUrl|src|imageSrc)"\s*:\s*"((?:\\.|[^"])*)"/gi
        cleaned = cleaned.replace(jsonUrl, (whole, raw) => normalizeMediaSource(raw, { allowAnyRemote: true }) ? '' : whole)
        const localPath = /(?:\/(?:Users|private|tmp|var(?:\/folders)?|Volumes|home|opt|workspace|mnt)\/[^\n"'`<>()[\],;]+?\.(?:png|jpe?g|gif|webp|bmp|avif)(?:[?#][^\n"'`<>()[\],;]*)?)/gi
        cleaned = cleaned.replace(localPath, '')
        const remoteUrl = /https?:\/\/[^\s<>"'`\)\]}]+/gi
        cleaned = cleaned.replace(remoteUrl, (raw) => normalizeMediaSource(raw) ? '' : raw)
        return cleaned.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim() === '' ? '' : cleaned
      }
      function imageOnlyScaffold(text) {
        return String(text || '').replace(/(?:path|outputPath|filePath|url|image_url|imageUrl|imageSrc)/gi, '').replace(/[\s{}\[\](),:"'=，。；：！？]+/g, '').trim() === ''
      }
      function textNodesUnder(root) {
        const nodes = []
        const visit = (node) => {
          if (!node) return
          if (node.nodeType === 3) {
            const parent = node.parentElement
            if (parent && !parent.closest(MEDIA_TEXT_SKIP_SELECTOR)) nodes.push(node)
            return
          }
          for (const child of node.childNodes || []) visit(child)
        }
        visit(root)
        return nodes
      }
      function mediaBlockFor(node, root) {
        let element = node && node.nodeType === 3 ? node.parentElement : node
        if (!element) return root
        const block = element.closest('p,pre,blockquote,li,h1,h2,h3,h4,h5,h6')
        return block && root.contains(block) ? block : element
      }
      function assistantMediaCard(items) {
        const card = document.createElement('div')
        card.className = 'zpm-assistant-media-card'
        card.dataset.zpmAssistantMedia = 'true'
        card.dataset.zpmMediaProcessed = 'true'
        card.dataset.zpmMediaCount = String(items.length)
        const grid = document.createElement('div')
        grid.className = 'zpm-assistant-media-grid'
        for (const item of items) {
          const trigger = document.createElement('button')
          trigger.type = 'button'
          trigger.className = 'zpm-assistant-media-trigger'
          trigger.title = '点击放大图片'
          trigger.setAttribute('aria-label', `放大图片 ${item.alt || '图片'}`)
          const image = document.createElement('img')
          image.className = 'zpm-assistant-media-image'
          image.alt = item.alt || '图片'
          image.loading = 'lazy'
          image.decoding = 'async'
          image.src = item.src
          const error = document.createElement('span')
          error.className = 'zpm-assistant-media-error'
          error.textContent = '图片暂时无法加载'
          error.hidden = true
          trigger.appendChild(image)
          trigger.appendChild(error)
          image.addEventListener('error', () => {
            if (item.fallbackSrc && image.getAttribute('data-zpm-fallback-used') !== 'true') {
              image.setAttribute('data-zpm-fallback-used', 'true')
              image.src = item.fallbackSrc
              return
            }
            trigger.dataset.zpmMediaError = 'true'
            error.hidden = false
          })
          trigger.addEventListener('click', (event) => {
            event.stopPropagation()
            if (trigger.dataset.zpmMediaError === 'true') return
            openLightbox(image.getAttribute('src') || item.src, item.alt || '图片')
          })
          grid.appendChild(trigger)
        }
        card.appendChild(grid)
        return card
      }
      function enhanceAssistantImages() {
        const flows = document.querySelectorAll('[data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="assistant"]')
        for (const flow of flows) {
          const root = flow.querySelector('[data-slot="conversation.chat.node"]') || flow
          const textRecords = []
          const textItems = []
          for (const node of textNodesUnder(root)) {
            const found = extractTextMedia(node.data)
            if (!found.length) continue
            textItems.push(...found)
            textRecords.push({ node, cleaned: stripTextMedia(node.data) })
          }
          const imageRecords = []
          for (const image of root.querySelectorAll('img')) {
            if (image.closest(MEDIA_SKIP_SELECTOR)) continue
            const raw = image.getAttribute('src') || image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('data-url') || image.getAttribute('alt') || ''
            const media = normalizeMediaSource(raw, { allowAnyRemote: true })
            if (!media) continue
            imageRecords.push({ image, media: { ...media, alt: mediaAlt(image.getAttribute('alt'), media.src) } })
          }
          if (!textItems.length && !imageRecords.length) continue
          const existingSources = new Set()
          for (const image of flow.querySelectorAll('.zpm-assistant-media-card img')) {
            const source = image.getAttribute('src')
            if (source) existingSources.add(source)
          }
          const items = dedupeMedia([
            ...textItems,
            ...imageRecords.map((record) => record.media),
          ]).filter((item) => !existingSources.has(item.src))
          const cleanTextSources = () => {
            for (const record of textRecords) {
              if (!record.node.isConnected) continue
              record.node.data = imageOnlyScaffold(record.cleaned) ? '' : record.cleaned
              if (record.node.parentElement) record.node.parentElement.dataset.zpmMediaProcessed = 'true'
              if (record.node.data === '' && record.node.parentElement && imageOnlyScaffold(record.node.parentElement.textContent)) {
                record.node.parentElement.classList.add('zpm-assistant-source-hidden')
              }
            }
          }
          const removeSourceImages = () => {
            for (const record of imageRecords) {
              const target = record.image.parentElement && record.image.parentElement.tagName === 'A' && record.image.parentElement.childNodes.length === 1
                ? record.image.parentElement
                : record.image
              if (target.isConnected) target.remove()
            }
          }
          if (!items.length) {
            cleanTextSources()
            removeSourceImages()
            continue
          }
          const firstText = textRecords[0] && mediaBlockFor(textRecords[0].node, root)
          const firstImage = imageRecords[0] && (imageRecords[0].image.closest('a') || imageRecords[0].image)
          const anchor = firstText || firstImage || root.firstElementChild || root
          const card = assistantMediaCard(items)
          if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(card, anchor)
          else root.appendChild(card)
          cleanTextSources()
          removeSourceImages()
        }
      }
      function syncProcessRows() {
        const flows = document.querySelectorAll('[data-chat-flow-kind="tool-call"]')
        for (const flow of flows) {
          const running = /运行中|正在执行|处理中|\bRunning\b/i.test(flow.textContent || '')
          flow.classList.toggle('zpm-running-tool', running)
        }
      }
      const scrubUi = () => { scrubDropOverlay(); enhanceVisionMessages(); enhanceAssistantImages(); syncProcessRows() }
      const onDragEvent = () => { queueMicrotask(scrubUi) }
      const overlayObserver = new MutationObserver(scrubUi)
      overlayObserver.observe(document.documentElement || document.body, { childList: true, subtree: true })
      window.addEventListener('dragenter', onDragEvent, true)
      window.addEventListener('dragover', onDragEvent, true)
      window.addEventListener('dragleave', onDragEvent, true)
      window.addEventListener('dragend', onDragEvent, true)
      window.addEventListener('drop', onDragEvent, true)
      scrubUi()
      ctx.effect(() => () => {
        overlayObserver.disconnect()
        window.removeEventListener('dragenter', onDragEvent, true)
        window.removeEventListener('dragover', onDragEvent, true)
        window.removeEventListener('dragleave', onDragEvent, true)
        window.removeEventListener('dragend', onDragEvent, true)
        window.removeEventListener('drop', onDragEvent, true)
      }, 'zhipu-media: drop-overlay remove')

      /* ---------- 2) 生图工具卡片 ---------- */
      function GenImageCard(props) {
        const block = props && props.block
        const [parsed, setParsed] = React.useState(null) // {url,fallbackUrl,error}
        const [usingFallback, setUsingFallback] = React.useState(false)
        React.useEffect(() => {
          if (!block || block.isError) { setParsed({ error: true }); return }
          const running = !block.content
          if (running) { setParsed({ running: true }); return }
          const texts = (block.content || [])
            .map((b) => (b && b.type === 'text' ? b.text : ''))
            .join('\n')
          const pathMatch = texts.match(/"path"\s*:\s*"([^"]+)"/)
          const urlMatch = texts.match(/"(?:url|image_url)"\s*:\s*"(https?:\\?\/\\?\/[^"\\s]+)"/)
          const path = pathMatch ? pathMatch[1].replace(/\\\//g, '/') : ''
          const remoteUrl = urlMatch ? urlMatch[1].replace(/\\\//g, '/') : ''
          const fallbackUrl = path ? '/zhipu-media/file?path=' + encodeURIComponent(path) : ''
          if (remoteUrl || fallbackUrl) {
            setUsingFallback(!remoteUrl)
            setParsed({ url: remoteUrl || fallbackUrl, fallbackUrl })
          } else {
            setParsed({ error: true })
          }
        }, [block])

        let body
        if (!parsed) {
          body = React.createElement('div', { className: 'zpm-pending' }, '图片加载中…')
        } else if (parsed.running) {
          body = React.createElement('div', { className: 'zpm-pending' }, '🖼️ 正在生成图片…')
        } else if (parsed.error) {
          body = React.createElement('div', { className: 'zpm-error' }, '❌ 图片生成失败，请稍后重试')
        } else {
          body = React.createElement('img', {
            className: 'zpm-img',
            src: usingFallback && parsed.fallbackUrl ? parsed.fallbackUrl : parsed.url,
            alt: 'AI 生成图片',
            onError: () => {
              if (!usingFallback && parsed.fallbackUrl) setUsingFallback(true)
            },
            onClick: (e) => {
              e.stopPropagation()
              openLightbox(usingFallback && parsed.fallbackUrl ? parsed.fallbackUrl : parsed.url, 'AI 生成图片')
            },
          })
        }
        return React.createElement('div', { className: 'zpm-gen-image' }, body)
      }
      slots.inject('tool.call.toolview', () => slots.register(
        { name: 'tool.call.toolview', key: 'mcp__zhipu__generate_image' },
        (props) => React.createElement(GenImageCard, props),
      ))

      /* ---------- 3) Lightbox ---------- */
      function Lightbox() {
        const lb = useLightbox()
        if (!lb) return null
        return React.createElement('div', {
          onClick: closeLightbox,
          style: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' },
        },
          React.createElement('img', { src: lb.url, alt: lb.alt || '', style: { maxWidth: '92vw', maxHeight: '92vh', objectFit: 'contain', borderRadius: 8, boxShadow: '0 10px 60px rgba(0,0,0,.5)' } }),
          React.createElement('button', { className: 'zpm-lightbox-close', onClick: (e) => { e.stopPropagation(); closeLightbox() }, 'aria-label': '关闭预览' }, '✕'),
        )
      }
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'zhipu-lightbox', order: 100, label: '图片放大预览' },
        () => React.createElement(Lightbox),
      ))
      const onKey = (e) => { if (e.key === 'Escape') closeLightbox() }
      window.addEventListener('keydown', onKey)
      ctx.effect(() => () => window.removeEventListener('keydown', onKey), 'zhipu-media: esc close')

      /* ---------- 4) 全局过程记录开关：默认隐藏已完成 Think / ToolCall ---------- */
      function ProcessToggle() {
        const expanded = useProcessExpanded()
        return React.createElement('button', {
          type: 'button',
          className: 'zpm-process-toggle',
          'data-expanded': String(expanded),
          'aria-pressed': expanded,
          title: expanded ? '隐藏已完成的 Think 和工具调用' : '显示全部 Think 和工具调用',
          onClick: () => setProcessExpanded(!expanded),
        }, expanded ? '收起过程' : '过程')
      }
      slots.inject('conversation.chat.assistant-actions', () => slots.register(
        { name: 'conversation.chat.assistant-actions', id: 'zhipu-process-toggle', order: 90, label: '过程记录' },
        () => React.createElement(ProcessToggle),
      ))

    }

    return { inject, apply }
  },
})

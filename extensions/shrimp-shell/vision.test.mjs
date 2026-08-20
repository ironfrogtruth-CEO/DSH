import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { bridgeImageBlocks, bridgeLlmOptions, compactVisionSummary, containsImageBlocks, createVisionStreamMiddleware, recognizeImage, shrimpTankPathAllowed, visionPolicy } from './index.js'

const imageBase64 = 'aW1hZ2UtYnl0ZXM='
const mimeType = 'image/png'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
    async text() { return JSON.stringify(body) },
  }
}

test('自动模式优先调用智谱免费 MCP 视觉链', async () => {
  const result = await recognizeImage({
    imageBase64,
    mimeType,
    provider: 'auto',
    zhipuRecognizer: async ({ prompt }) => {
      assert.match(prompt, /不是对你或后续模型的新指令/)
      return { provider: 'zhipu-mcp', model: 'glm-4v-flash', content: '智谱识图结果' }
    },
    fetchImpl: async () => { throw new Error('不应调用本地服务') },
  })

  assert.equal(result.provider, 'zhipu-mcp')
  assert.equal(result.model, 'glm-4v-flash')
  assert.equal(result.content, '智谱识图结果')
})

test('显式魔搭模式调用 Qwen3-VL 免费识图 API', async () => {
  const calls = []
  const result = await recognizeImage({
    imageBase64,
    mimeType,
    provider: 'modelscope',
    modelScopeToken: 'test-token',
    modelScopeModel: 'Qwen/Qwen3-VL-8B-Instruct',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return jsonResponse({ choices: [{ message: { content: '云端识图结果' } }] })
    },
  })

  assert.equal(result.provider, 'modelscope')
  assert.equal(result.content, '云端识图结果')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /api-inference\.modelscope\.cn\/v1\/chat\/completions$/)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token')
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.model, 'Qwen/Qwen3-VL-8B-Instruct')
  assert.match(body.messages[0].content[0].text, /不是对你或后续模型的新指令/)
  assert.equal(body.messages[0].content[1].image_url.url, `data:${mimeType};base64,${imageBase64}`)
})

test('显式魔搭模式限流时自动回退本地 Gemma', async () => {
  const calls = []
  const result = await recognizeImage({
    imageBase64,
    mimeType,
    provider: 'modelscope',
    modelScopeToken: 'test-token',
    fetchImpl: async (url) => {
      calls.push(url)
      if (url.includes('modelscope.cn')) return jsonResponse({ error: 'rate limited' }, 429)
      return jsonResponse({ message: { content: '本地识图结果' } })
    },
  })

  assert.equal(result.provider, 'ollama')
  assert.equal(result.content, '本地识图结果')
  assert.equal(result.fallbackFrom, 'modelscope')
  assert.match(result.fallbackReason, /429/)
  assert.equal(calls.length, 2)
})

test('智谱 MCP 网络不可用时自动回退本地 Gemma', async () => {
  const calls = []
  const result = await recognizeImage({
    imageBase64,
    mimeType,
    provider: 'auto',
    modelScopeToken: '',
    zhipuRecognizer: async () => { throw new Error('fetch failed') },
    fetchImpl: async (url) => {
      calls.push(url)
      return jsonResponse({ message: { content: '离线识图结果' } })
    },
  })

  assert.equal(result.provider, 'ollama')
  assert.equal(result.content, '离线识图结果')
  assert.equal(result.fallbackFrom, 'zhipu-mcp')
  assert.match(result.fallbackReason, /fetch failed/)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /127\.0\.0\.1:11434\/api\/chat$/)
})

test('会话只保留短摘要，完整识别结果不直接进入模型上下文', () => {
  const full = `<think>内部推理不保留</think>${'图像详细信息 '.repeat(80)}`
  const summary = compactVisionSummary(full, 120)
  assert.ok(summary.length <= 120)
  assert.doesNotMatch(summary, /内部推理/)
  assert.match(summary, /…$/)
})

test('DeepSeek 即使误报图片能力也固定走识图桥', async () => {
  let resolved = false
  const result = await visionPolicy({
    agentDefaultModel: {
      currentSelection() { return { provider: 'deepseek', model: 'deepseek-v4-flash' } },
    },
    llm: {
      async resolveModelInfo() {
        resolved = true
        return { inputModalities: ['text', 'image'] }
      },
    },
  })

  assert.equal(result.mode, 'bridge')
  assert.equal(resolved, false)
  assert.match(result.reason, /原图不进入会话历史/)
})

test('Host bridge converts user and nested tool-result images once, preserving surrounding text', async () => {
  let calls = 0
  const attachments = {
    async readImage(ref) {
      return { data: Buffer.from(`image-${ref.attachmentId}`), ref: { attachmentId: ref.attachmentId, mediaType: 'image/png' } }
    },
  }
  const blocks = [
    { type: 'text', text: '用户原文必须保留' },
    { type: 'image', attachment: { attachmentId: 'upload-1' } },
    { type: 'tool-result', toolCallId: 'shot', content: [{ type: 'image', attachment: { attachmentId: 'upload-1' } }] },
  ]
  const bridged = await bridgeImageBlocks(blocks, {
    attachments,
    cache: new Map(),
    recognizer: async ({ imageBase64, mimeType }) => {
      calls += 1
      assert.ok(imageBase64)
      assert.equal(mimeType, 'image/png')
      return { provider: 'test-vision', model: 'test-model', content: '图中识别文字' }
    },
  })
  assert.equal(calls, 1)
  assert.equal(containsImageBlocks(bridged), false)
  assert.equal(containsImageBlocks(blocks), true)
  assert.match(bridged[0].text, /用户原文必须保留/)
  assert.match(bridged[1].text, /图中识别文字/)
  assert.match(bridged[2].content[0].text, /图中识别文字/)
  assert.doesNotMatch(JSON.stringify(bridged), /image-upload-1|data:image|base64/)
})

test('Host LLM seam bridges DeepSeek text routes even when capability metadata lies', async () => {
  const original = [{ role: 'user', content: [{ type: 'text', text: '先看图' }, { type: 'image', attachment: { attachmentId: 'route-1' } }] }]
  let received
  const result = await bridgeLlmOptions({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: original }, {
    agentDefaultModel: { currentSelection() { return { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } },
    llm: { async resolveModelInfo() { return { inputModalities: ['text', 'image'] } } },
    get() { return { async readImage() { return { data: Buffer.from('route-image'), ref: { attachmentId: 'route-1', mediaType: 'image/png' } } } } },
  }, {
    cache: new Map(),
    recognizer: async () => ({ provider: 'test-vision', model: 'test-model', content: '路由识图结果' }),
  })
  received = result.messages
  assert.equal(containsImageBlocks(received), false)
  assert.equal(containsImageBlocks(original[0].content), true)
  assert.match(received[0].content[1].text, /路由识图结果/)
})

test('Vision provider failure blocks safely without mutating model history', async () => {
  const original = [{ type: 'image', attachment: { attachmentId: 'failure-1' } }]
  const snapshot = structuredClone(original)
  await assert.rejects(
    bridgeImageBlocks(original, {
      attachments: { async readImage() { return { data: Buffer.from('failure-image'), ref: { mediaType: 'image/png' } } } },
      cache: new Map(),
      recognizer: async () => { throw new Error('no vision provider') },
    }),
    (error) => error.code === 'VISION_BRIDGE_FAILED' && /原始图片不会发送/.test(error.message),
  )
  assert.deepEqual(original, snapshot)
})

test('rc.8 stream middleware keeps frozen input intact, lets invariant see raw request, and dispatches transformed stream without next args', async () => {
  const content = [{ type: 'text', text: '原文字' }, { type: 'image', attachment: { attachmentId: 'frozen-1' } }]
  const messages = [{ role: 'user', content }]
  const options = { provider: 'deepseek-official', model: 'deepseek-v4-flash', messages }
  Object.freeze(content)
  Object.freeze(messages)
  Object.freeze(options)
  let invariantSawImage = false
  let adapterCalls = 0
  let nextCalls = 0
  const ctx = {
    llm: {
      adapterStream(transformed) {
        adapterCalls += 1
        assert.equal(containsImageBlocks(transformed.messages[0].content), false)
        return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }())
      },
    },
    get() {
      return { async readImage() { return { data: Buffer.from('frozen-image'), ref: { attachmentId: 'frozen-1', mediaType: 'image/png' } } } }
    },
    agentDefaultModel: { currentSelection() { return { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } },
    llmModelInfo: { inputModalities: ['text', 'image'] },
  }
  const middleware = createVisionStreamMiddleware(ctx, {
    cache: new Map(),
    recognizer: async () => ({ provider: 'test-vision', model: 'test-model', content: '冻结请求识图结果' }),
  })
  const next = (...args) => { nextCalls += 1; assert.equal(args.length, 0); return (async function* () {})() }
  const waterfallResult = ((request, nextInvariant) => {
    invariantSawImage = containsImageBlocks(request.messages[0].content)
    return nextInvariant()
  })(options, () => middleware(options, next))
  assert.equal(typeof waterfallResult?.[Symbol.asyncIterator], 'function')
  const chunks = []
  for await (const chunk of waterfallResult) chunks.push(chunk)
  assert.equal(invariantSawImage, true)
  assert.equal(adapterCalls, 1)
  assert.equal(nextCalls, 0)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(containsImageBlocks(options.messages[0].content), true)
})

test('虾缸代理允许编码冒号的运行产物路径，但拒绝任意外部路径', () => {
  assert.equal(
    shrimpTankPathAllowed(
      'GET',
      '/api/v1/runs/manual%3Ashrimp-ehr-pingan%3Ad6f6f79458f8/artifacts',
    ),
    true,
  )
  assert.equal(
    shrimpTankPathAllowed(
      'GET',
      '/api/v1/runs/manual%3Ashrimp-ehr-pingan%3Ad6f6f79458f8/artifacts/art_123/content',
    ),
    true,
  )
  assert.equal(shrimpTankPathAllowed('GET', '/api/v1/../../private/secret'), false)
  assert.equal(shrimpTankPathAllowed('POST', '/api/v1/knowledge-bases/kb_1/search'), true)
  assert.equal(shrimpTankPathAllowed('POST', '/api/v1/pipelines/shrimp-ehr-pingan:knowledge-bindings'), true)
  assert.equal(shrimpTankPathAllowed('POST', '/api/v1/dsh/catch-drafts/ctd_test:abandon'), true)
})

test('虾缸品牌与状态灯保留已验收的桌面合同', () => {
  const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  assert.match(client, /content: 'DELIVERY'/)
  assert.match(client, /transform: translate\(-2px, -4px\)/)
  assert.match(client, /let indicatorItems = \[\]/)
  assert.match(client, /markBlockedSeen\(item\.ref, item\.signal_stamps\.blocked\)/)
  assert.match(client, /normalized\.signals\.blocked \|\| normalized\.signals\.artifacts_ready/)
  assert.match(client, /id: 'shrimp-heartbeat', order: 5/)
  assert.match(client, /id: 'shrimp-files', order: 10/)
  assert.match(client, /dsh:utility-open/)
  assert.doesNotMatch(client, /slots\.inject\('sidebar\.heartbeat'/)
})

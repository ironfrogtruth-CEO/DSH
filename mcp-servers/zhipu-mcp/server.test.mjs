import assert from 'node:assert/strict'
import test from 'node:test'

import { chatWithImageDetailed } from './server.mjs'

test('共享视觉实现返回实际回退模型，导入模块时不会启动 stdio 主循环', async () => {
  const calls = []
  const result = await chatWithImageDetailed({
    imageUrl: 'data:image/png;base64,aW1hZ2U=',
    prompt: '只提取图片事实',
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return {
        ok: true,
        status: 200,
        async json() { return { choices: [{ message: { content: '识别完成' } }] } },
      }
    },
  })

  assert.equal(result.provider, 'zhipu-mcp')
  assert.equal(result.model, 'glm-4.6v-flash')
  assert.equal(result.content, '识别完成')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key')
  assert.ok(calls[0].options.signal)
})

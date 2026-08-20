import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('checkpoint appends durable history and recall returns bounded relevant context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'))
  process.env.DSH_MEMORY_ROOT = root
  try {
    const { apply } = await import(`./index.js?test=${Date.now()}`)
    const catalog = []
    apply({ tools: { register(tool) { catalog.push(tool) } } })
    const checkpoint = catalog.find((tool) => tool.name === 'memory_checkpoint')
    const recall = catalog.find((tool) => tool.name === 'memory_recall')
    assert.ok(checkpoint)
    assert.ok(recall)

    const first = await checkpoint.execute({ key: 'project-shrimptank', content: '## Objective\n修复知识目录\n## Next action\n运行前端测试' })
    const second = await checkpoint.execute({ key: 'project-shrimptank', content: '## Validation evidence\n前端测试 7/7\n## Next action\n真实页面验收' })
    await checkpoint.execute({ key: 'zhipu-mcp-config', content: 'DeepSeek 图片路由配置，与编码能力无关。' })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    const stored = await readFile(first.path, 'utf8')
    assert.equal((stored.match(/## Checkpoint/g) || []).length, 2)

    const result = await recall.execute({ query: 'shrimptank 前端测试', maxChars: 1800 })
    assert.equal(result.ok, true)
    assert.match(result.matchedKeys, /project-shrimptank/)
    assert.match(result.context, /前端测试 7\/7/)
    assert.ok(result.context.length <= 1800)

    const unrelated = await recall.execute({ query: 'DeepSeek Harness 可靠开发', maxChars: 1800 })
    assert.doesNotMatch(unrelated.matchedKeys, /zhipu-mcp-config/)

    const blocked = await checkpoint.execute({ key: 'secret-test', content: 'API_KEY=should-not-store' })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /凭据/)
  } finally {
    delete process.env.DSH_MEMORY_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { apiErrorFromPayload, knowledgeId, knowledgeReadPathAllowed, readKnowledgeBase, safeTankBaseUrl } from './index.js'

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async json() { return payload },
  }
}

test('知识库只读 Host allowlist 只开放 list/get/search', () => {
  assert.equal(knowledgeReadPathAllowed('GET', '/api/v1/knowledge-bases'), true)
  assert.equal(knowledgeReadPathAllowed('GET', '/api/v1/knowledge-bases/kb_demo'), true)
  assert.equal(knowledgeReadPathAllowed('POST', '/api/v1/knowledge-bases/kb_demo/search'), true)
  assert.equal(knowledgeReadPathAllowed('POST', '/api/v1/knowledge-bases'), false)
  assert.equal(knowledgeReadPathAllowed('PATCH', '/api/v1/knowledge-bases/kb_demo'), false)
  assert.equal(knowledgeReadPathAllowed('DELETE', '/api/v1/knowledge-bases/kb_demo'), false)
  assert.equal(knowledgeReadPathAllowed('POST', '/api/v1/knowledge-bases/kb_demo:archive'), false)
  assert.equal(knowledgeReadPathAllowed('POST', '/api/v1/knowledge-bases/kb_demo/documents/upload'), false)
  assert.equal(knowledgeReadPathAllowed('GET', '/api/v1/knowledge-bases/%2e%2e/private'), false)
  assert.equal(knowledgeId('kb_demo-1'), 'kb_demo-1')
  assert.equal(knowledgeId('kb/demo'), '')
  assert.equal(safeTankBaseUrl('http://127.0.0.1:7843').hostname, '127.0.0.1')
  assert.throws(() => safeTankBaseUrl('https://example.com'), /只允许访问本机/)
})

test('只读 list/get 不改变请求；search 必须带 Idempotency-Key', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    return jsonResponse({ schema: 'api_envelope.v1', data: { items: [{ id: 'kb_demo', name: '演示库' }] } })
  }
  const listed = await readKnowledgeBase({ action: 'list', fetchImpl })
  assert.equal(listed.ok, true)
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.body, undefined)

  const searched = await readKnowledgeBase({ action: 'search', id: 'kb_demo', query: '来源', fetchImpl })
  assert.equal(searched.ok, true)
  assert.equal(calls[1].options.method, 'POST')
  assert.match(calls[1].options.headers['Idempotency-Key'], /^dsh-kb-read:kb_demo:/)
  assert.match(calls[1].options.body, /来源/)
})

test('FastAPI detail.code/detail.message 能保留为稳定错误合同', () => {
  assert.deepEqual(apiErrorFromPayload({ detail: { code: 'KB_FORBIDDEN', message: '没有权限' } }, 403), {
    code: 'KB_FORBIDDEN', message: '没有权限', status: 403,
  })
})

test('知识库管理客户端保留 UI CRUD、确认门和可访问交互合同', () => {
  const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  assert.match(client, /settings\.section'.*order: 100/s)
  assert.match(client, /label: '虾缸知识库'/)
  assert.match(client, /settingsSection: true/)
  assert.match(client, /if \(!settingsSection && !open\)/)
  assert.doesNotMatch(client, /sidebar\.footer\.action'.*dsh-knowledge-manager/s)
  assert.match(client, /role: 'dialog'/)
  assert.match(client, /'aria-modal': true/)
  assert.match(client, /event\.key === 'Escape'/)
  assert.match(client, /onMouseDown: \(event\) => \{ if \(event\.target === event\.currentTarget\) close\(\) \}/)
  assert.match(client, /\/api\/v1\/knowledge-bases'/)
  assert.match(client, /write\('PATCH'/)
  assert.match(client, /write\('DELETE'/)
  assert.match(client, /:archive/)
  assert.match(client, /Idempotency-Key/)
  assert.match(client, /软删除，会撤销该知识库的 Grant；共享源文件不会被删除/)
  assert.match(client, /按名称或说明即时筛选/)
  assert.match(client, /没有读取知识库的权限/)
  assert.match(client, /虾缸当前不可用或网络已断开/)
  assert.doesNotMatch(client, /documents\/upload/)
})

test('知识库弹窗把列表和详情作为同级列，并避免 HiDPI Mac 被误判为窄屏', () => {
  const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  assert.match(client, /className: 'dsh-kb-content'/)
  assert.match(client, /dsh-kb-list'[\s\S]*?\)\),\n\s+mode !== 'view' \? formPanel/)
  assert.match(client, /dsh-kb-content\{grid-template-columns:minmax\(170px,\.9fr\) minmax\(0,1\.35fr\)!important/)
  assert.match(client, /@media\(max-width:520px\) and \(pointer:coarse\),\(max-width:380px\)/)
  assert.match(client, /grid-template-columns:1fr!important;grid-template-rows:minmax\(160px/)
  assert.match(client, /dsh-kb-settings-section/)
  assert.match(client, /dsh-kb-settings-section\{box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-height:0/)
})

test('模型工具只有只读能力，写操作只存在于显式按钮处理器', () => {
  const host = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  assert.match(host, /name: 'knowledge_bases'/)
  assert.match(host, /list、get 或 search/)
  assert.match(host, /不能新增、修改、归档、删除知识库/)
  assert.doesNotMatch(host, /method = 'PATCH'|method = 'DELETE'|:archive/)
})

test('模型工具的开放对象 schema 显式声明 additionalProperties', () => {
  const host = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  assert.match(host, /data:\s*\{\s*type:\s*'object',\s*additionalProperties:\s*true\s*\}/)
})

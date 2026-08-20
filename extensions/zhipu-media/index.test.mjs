import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from './index.js'

function responseRecorder() {
  return {
    code: 0,
    headers: {},
    body: null,
    writeHead(code, headers = {}) { this.code = code; this.headers = headers },
    end(body) { this.body = body },
  }
}

test('authorized local image route serves Desktop images without allowing arbitrary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zhipu-media-local-test-'))
  const routes = []
  apply({
    effect(register) { register() },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }, { localRoots: [dir] })
  const route = routes.find((item) => item.path === '/zhipu-media/file')
  assert.ok(route)

  const denied = responseRecorder()
  await route.handler({ url: '/zhipu-media/file?path=%2Fetc%2Fpasswd' }, denied)
  assert.equal(denied.code, 404)

  try {
    const imagePath = join(dir, 'preview.png')
    await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'))
    const allowed = responseRecorder()
    await route.handler({ url: `/zhipu-media/file?path=${encodeURIComponent(imagePath)}` }, allowed)
    assert.equal(allowed.code, 200)
    assert.equal(allowed.headers['Content-Type'], 'image/png')
    assert.equal(allowed.headers['X-Content-Type-Options'], 'nosniff')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('generated media route rejects symlinks outside managed roots and unsupported files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhipu-media-generated-test-'))
  const routes = []
  apply({
    effect(register) { register() },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }, { generatedRoots: [root] })
  const route = routes.find((item) => item.kind === 'prefix' && item.path === '/zhipu-media')
  assert.ok(route)

  try {
    const imageName = 'preview.png'
    const unsupportedName = 'notes.txt'
    const escapedName = 'escaped.png'
    await writeFile(join(root, imageName), Buffer.from('89504e470d0a1a0a', 'hex'))
    await writeFile(join(root, unsupportedName), 'not media')
    await symlink('/etc/passwd', join(root, escapedName))

    const allowed = responseRecorder()
    await route.handler({ url: `/zhipu-media/${encodeURIComponent(imageName)}` }, allowed)
    assert.equal(allowed.code, 200)
    assert.equal(allowed.headers['Content-Type'], 'image/png')
    assert.equal(allowed.headers['X-Content-Type-Options'], 'nosniff')

    const unsupported = responseRecorder()
    await route.handler({ url: `/zhipu-media/${encodeURIComponent(unsupportedName)}` }, unsupported)
    assert.equal(unsupported.code, 404)

    const escaped = responseRecorder()
    await route.handler({ url: `/zhipu-media/${encodeURIComponent(escapedName)}` }, escaped)
    assert.equal(escaped.code, 404)

  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

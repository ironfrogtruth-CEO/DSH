import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const ROOT = resolve(new URL('.', import.meta.url).pathname, '../..')
const shrimpClientPath = resolve(ROOT, 'extensions/shrimp-shell/client.js')
const customClientPath = resolve(ROOT, 'custom-ui-patches/shrimp-shell/client.js.modified')
const gitClientPath = resolve(ROOT, 'extensions/dsh-git/client.js')

test('顶部工具栏 CSS 合同锁定统一胶囊尺寸与横向布局', async () => {
  const source = await readFile(shrimpClientPath, 'utf8')
  assert.match(source, /shrimp-header-utilities-styles/)
  assert.match(source, /data-dsh-header-utilities/)
  assert.match(source, /display: flex !important; flex: 0 1 auto !important; flex-direction: row !important/)
  assert.match(source, /overflow-x: auto !important/)
  assert.match(source, /height: 36px !important; min-height: 36px !important; max-height: 36px !important/)
  assert.match(source, /flex: 0 0 auto !important/)
  assert.match(source, /width: 16px !important; height: 16px !important; flex: 0 0 16px !important/)
  assert.match(source, /button\[aria-label="轨迹"\]/)
  assert.match(source, /button\[aria-label="心跳"\]/)
  assert.match(source, /button\[aria-label="Git"\]/)
  assert.match(source, /button\[aria-label="项目与产物"\]/)
})

test('正式 shrimp client 与 custom patch 保持同一顶部工具栏实现', async () => {
  const [shrimp, custom] = await Promise.all([readFile(shrimpClientPath, 'utf8'), readFile(customClientPath, 'utf8')])
  assert.equal(custom, shrimp)
})

test('Git 工具自身也具备 HMR 后的固定高度与不可拉伸合同', async () => {
  const source = await readFile(gitClientPath, 'utf8')
  assert.match(source, /\.dsh-git-root\{[^}]*display:flex;[^}]*flex:0 0 auto;[^}]*height:36px/)
  assert.match(source, /\.dsh-git-trigger\{[^}]*display:inline-flex;[^}]*flex:0 0 auto;[^}]*height:36px/)
  assert.match(source, /\.dsh-git-trigger svg\{[^}]*width:16px;height:16px;flex:0 0 16px/)
})

test('深浅主题的 wordmark 与 Delivery 共用同一视觉中线', async () => {
  const [source, custom] = await Promise.all([
    readFile(shrimpClientPath, 'utf8'),
    readFile(customClientPath, 'utf8'),
  ])
  assert.match(source, /--shrimp-wordmark-y: 6px; --shrimp-delivery-y: -4px/)
  assert.match(source, /body\[data-ds-dark-theme\] \.shrimp-harness-brand \{ --shrimp-delivery-y: 2\.5px; \}/)
  assert.match(source, /\.shrimp-harness-brand::before \{ transform: translateY\(var\(--shrimp-wordmark-y\)\); \}/)
  assert.match(source, /wordmark-dark-cropped\.png/)
  assert.match(source, /wordmark-light-cropped\.png/)
  assert.match(source, /\.shrimp-rail-brand::before/)
  assert.match(source, /content: 'DELIVERY'/)
  assert.match(source, /transform: translate\(-2px, var\(--shrimp-delivery-y\)\)/)
  assert.match(source, /min-width: 80px; height: 28px; padding: 0 10px; border-radius: 6px/)
  assert.match(source, /font: 650 9\.5px\/1 ui-sans-serif/)
  assert.match(source, /letter-spacing: \.14em/)
  assert.doesNotMatch(source, /transform: translate\(-2px, -(?:3|4)px\)/)
  assert.equal(custom, source, '正式 shrimp client 与 custom patch 必须同步')
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('media renderer and turn-tail process control mount without shadowing the core tool tree', async () => {
  const registrations = []
  const components = new Map()
  let bundle
  let overlayRemoved = false
  const overlay = { textContent: '图片拖动到此处即可添加', remove() { overlayRemoved = true } }
  const style = { isConnected: true, remove() {} }
  const document = {
    createElement: () => style,
    getElementById: () => null,
    head: { appendChild() {} },
    documentElement: {},
    body: { dataset: {} },
    querySelectorAll: (selector) => selector === 'div[role="status"]' ? [overlay] : [],
    addEventListener() {},
    removeEventListener() {},
  }
  const window = {
    __ModuleLoader__: { load(value) { bundle = value } },
    addEventListener() {},
    removeEventListener() {},
  }
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  class MutationObserver {
    constructor(callback) { this.callback = callback }
    observe() { this.callback() }
    disconnect() {}
  }
  vm.runInNewContext(source, { document, window, MutationObserver, queueMicrotask(fn) { fn() } }, { filename: 'client.js' })
  assert.equal(bundle.id, '@local/zhipu-media')

  const React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type({ ...(props || {}), children })
      return { type, props: props || {}, children }
    },
    useEffect() {},
    useMemo(value) { return value() },
    useReducer() { return [0, () => {}] },
    useState(value) { return [value, () => {}] },
  }
  const plugin = bundle.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  const slots = {
    inject(_name, mount) { mount() },
    register(options, component) {
      registrations.push(options)
      components.set(`${options.name}:${options.key || options.id || ''}`, component)
      return () => {}
    },
  }
  plugin.apply({
    effect() {},
    get(name) { return name === 'slots' ? slots : null },
  })

  assert.equal(registrations.some((entry) => entry.name === 'conversation.chat.node' && entry.key === 'tool-call'), false)
  assert.equal(overlayRemoved, true)
  assert.ok(components.get('tool.call.toolview:mcp__zhipu__generate_image'))
  assert.ok(components.get('conversation.chat.assistant-actions:zhipu-process-toggle'))
  assert.equal(source.includes("className: 'zpm-meta'"), false)
  assert.equal(source.includes('parsed.raw'), false)
  assert.equal(source.includes('texts.slice(0, 300)'), false)
  assert.match(source, /zhipu-media\/file\?path=/)
  assert.match(source, /\(\?:url\|image_url\)/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

test('大神 app declares the Messages Automation permission without changing its bundle id', async () => {
  const plist = await readFile(join(import.meta.dirname, 'Info.plist'), 'utf8')
  assert.match(plist, /<key>NSAppleEventsUsageDescription<\/key>/)
  assert.match(plist, /Messages/)
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>local\.dsh\.dashen<\/string>/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

test('大神 app keeps its bundle id and does not request Messages or Apple Events permissions', async () => {
  const plist = await readFile(join(import.meta.dirname, 'Info.plist'), 'utf8')
  assert.doesNotMatch(plist, /Messages|AppleEvents|NSAppleEventsUsageDescription/)
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>local\.dsh\.dashen<\/string>/)
  assert.match(plist, /NSMicrophoneUsageDescription/)
  assert.match(plist, /NSSpeechRecognitionUsageDescription/)
})

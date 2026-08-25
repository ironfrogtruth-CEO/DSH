import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(root, '大神.swift')

test('red close hides the window, Dock reopen restores it, and explicit quit stops Host', async () => {
  const source = await readFile(sourcePath, 'utf8')
  assert.match(source, /NSWindowDelegate/)
  assert.match(source, /window\.isReleasedWhenClosed\s*=\s*false/)
  assert.match(source, /func windowShouldClose[\s\S]*orderOut\(nil\)[\s\S]*return false/)
  assert.match(source, /applicationShouldTerminateAfterLastWindowClosed[\s\S]*return false/)
  assert.match(source, /applicationShouldHandleReopen[\s\S]*makeKeyAndOrderFront/)
  assert.match(source, /applicationShouldTerminate[\s\S]*isTerminating = true/)
  assert.match(source, /applicationWillTerminate[\s\S]*if audioEngine\.isRunning \|\| recognitionRequest != nil \|\| recognitionTask != nil/)
  assert.match(source, /applicationWillTerminate[\s\S]*STOP_SCRIPT[\s\S]*waitUntilExit/)
  assert.match(source, /func cleanupRecording\(\)[\s\S]*if audioEngine\.isRunning[\s\S]*removeTap/)
})

test('Swift app source compiles without replacing the deployed app', async () => {
  const output = await mkdtemp(join(tmpdir(), 'dashen-close-lifecycle-'))
  try {
    const result = spawnSync('swiftc', ['-O', '-o', join(output, '大神'), sourcePath, '-framework', 'Cocoa', '-framework', 'WebKit', '-framework', 'Speech', '-framework', 'AVFoundation'], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

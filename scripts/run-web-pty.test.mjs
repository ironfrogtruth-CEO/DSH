import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const runner = resolve(import.meta.dirname, 'run-web-pty.py')

test('run-web-pty keeps detached child stdin attached to a PTY', () => {
  const result = spawnSync(
    '/usr/bin/python3',
    [runner, process.execPath, '-e', 'console.log(JSON.stringify({stdin:process.stdin.isTTY,stdout:process.stdout.isTTY}));'],
    { encoding: 'utf8', timeout: 5000 },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(JSON.parse(result.stdout.trim()), { stdin: true, stdout: true })
})

test('run-web-pty rejects an empty command', () => {
  const result = spawnSync('/usr/bin/python3', [runner], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /missing command/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { allowedGitPathCandidate, normalizeGitFiles, validateGitAction } from './index.js'

test('Git 路径只允许本机工作区并拒绝穿越', () => {
  assert.equal(allowedGitPathCandidate('/Users/marcus/Desktop/虾缸').ok, true)
  assert.equal(allowedGitPathCandidate('/Users/marcus/.dsh').ok, true)
  assert.equal(allowedGitPathCandidate('/tmp/demo').code, 'GIT_PATH_OUTSIDE_ALLOWLIST')
  assert.equal(allowedGitPathCandidate('/Users/marcus/Desktop/../private').code, 'GIT_PATH_TRAVERSAL')
  assert.throws(() => normalizeGitFiles('../secret'), /文件路径无效/)
  assert.throws(() => normalizeGitFiles('/etc/passwd'), /文件路径无效/)
})

test('Git 写操作要求提交信息和推送确认', () => {
  assert.equal(validateGitAction('commit', {}).code, 'GIT_MESSAGE_REQUIRED')
  assert.equal(validateGitAction('commit', { message: 'fix: safe commit' }).ok, true)
  assert.equal(validateGitAction('push', {}).code, 'GIT_PUSH_CONFIRM_REQUIRED')
  assert.equal(validateGitAction('push', { confirm: true }).ok, true)
  assert.equal(validateGitAction('commit_push', { message: 'ship' }).code, 'GIT_PUSH_CONFIRM_REQUIRED')
  assert.equal(validateGitAction('commit_push', { message: 'ship', confirm: true }).ok, true)
})

test('Git 客户端入口与确认门合同保持稳定', () => {
  const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  assert.match(client, /id: 'dsh-git-utility', order: 6/)
  assert.match(client, /确认把 .* 推送到远端/)
  assert.match(client, /一键提交并推送/)
  assert.match(client, /暂存「.*」的全部改动/)
  assert.match(client, /dsh:utility-open/)
  assert.doesNotMatch(client, /reset --hard|checkout --|clean -f/)
})

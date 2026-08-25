import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { allowedGitPathCandidate, limitStatusRows, normalizeGitFiles, parseStatus, validateGitAction } from './index.js'

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

test('状态默认折叠未跟踪目录并限制客户端行数', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  assert.match(source, /status', '--short', '--untracked-files=normal'/)
  const files = parseStatus(' M tracked.js\n?? attachments/\n?? output/\n')
  assert.equal(files.length, 3)
  const limited = limitStatusRows(Array.from({ length: 205 }, (_, index) => ({ path: `file-${index}` })))
  assert.equal(limited.files.length, 200)
  assert.equal(limited.statusCount, 205)
  assert.equal(limited.statusTruncated, true)
})

test('Git 客户端入口与确认门合同保持稳定', () => {
  const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  assert.match(client, /id: 'dsh-git-utility', order: 6/)
  assert.match(client, /确认把 .* 推送到远端/)
  assert.match(client, /一键提交并推送/)
  assert.match(client, /全部未提交项/)
  assert.match(client, /未提交项：\$\{dirtyCount\}/)
  assert.match(client, /dsh:utility-open/)
  assert.match(client, /仅显示前 200 项/)
  assert.doesNotMatch(client, /改动文件 · \$\{files\.length\}/)
  assert.doesNotMatch(client, /reset --hard|checkout --|clean -f/)
})

test('每日本地提交锁会阻断 dsh-git 的写操作', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  assert.match(source, /dsh-daily-commit\.lock/)
  assert.match(source, /GIT_DAILY_COMMIT_RUNNING/)
  assert.match(source, /action === 'stage' \|\| action === 'unstage' \|\| action === 'commit' \|\| action === 'commit_push'/)
})

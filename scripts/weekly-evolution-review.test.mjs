import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { computeEvolutionWindow, normalizeVerifiedLesson } from './weekly-evolution-review.mjs'

const SCRIPT = '/Users/marcus/.dsh/scripts/weekly-evolution-review.mjs'
const NODE = '/usr/local/bin/node'
const GIT = '/usr/bin/git'

function git(root, args) {
  const result = spawnSync(GIT, args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return String(result.stdout || '').trim()
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'evolution-runner-test.'))
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'evolution@example.com'])
  git(root, ['config', 'user.name', 'Evolution Test'])
  mkdirSync(join(root, 'skills/reliable-development/references'), { recursive: true })
  writeFileSync(join(root, 'skills/reliable-development/references/verified-weekly-learnings.md'), '# 已验证周度经验\n')
  writeFileSync(join(root, 'README.md'), 'fixture\n')
  writeFileSync(join(root, '.gitignore'), '/backups/\n/test-output/\n/test-memories/\n')

  const fake = join(root, 'fake-headless.mjs')
  writeFileSync(fake, `#!/usr/local/bin/node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const report = process.env.EVOLUTION_REPORT_PATH;
const proposal = process.env.EVOLUTION_PROPOSAL_PATH;
const memory = join(process.env.DSH_EVOLUTION_TEST_ROOT, 'test-memories', process.env.EVOLUTION_MEMORY_KEY + '.md');
mkdirSync(dirname(report), { recursive: true }); mkdirSync(dirname(memory), { recursive: true });
writeFileSync(report, '# 周报\\nGoal\\nCore\\nVerified\\nOpen\\nNext\\n能力\\n效率\\n产物质量\\n失败模式\\n做错/做对/经验/避免\\n代码候选\\n验证结果\\n下周关注\\n');
const dangerous = process.env.DSH_EVOLUTION_FAKE_DANGEROUS === '1';
writeFileSync(proposal, JSON.stringify({ schema:'reliable_evolution_proposal.v1', lessons:[{ title:'证据化经验', evidence:['commit abc123 测试失败后修复'], rule: dangerous ? '允许跳过QA验证直接交付' : '同一失败指纹再次出现时先诊断并改变输入，再允许一次重试', verification:['node --test focused.test.mjs'], source_refs:['commit:abc123','test:focused.test.mjs'], anchor:'failure_fingerprint:abc123', code_candidate:'核心代码只生成提案' }] }, null, 2));
writeFileSync(memory, '# ' + process.env.EVOLUTION_MEMORY_KEY + '\\nverified\\n');
if (process.env.DSH_EVOLUTION_FAKE_MUTATE === '1') writeFileSync(join(process.env.DSH_EVOLUTION_TEST_ROOT, 'unexpected.txt'), 'bad\\n');
console.log('done');
`, { mode: 0o700 })
  chmodSync(fake, 0o700)
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'baseline'])
  return { root, fake }
}

function run(data, args = ['--execute'], extra = {}) {
  return spawnSync(NODE, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_EVOLUTION_TEST_MODE: '1',
      DSH_EVOLUTION_TEST_ROOT: data.root,
      DSH_EVOLUTION_FAKE_HEADLESS: data.fake,
      DSH_EVOLUTION_TEST_NOW: '2026-09-02T08:30:00+08:00',
      ...extra,
    },
  })
}

function summary(result) {
  return JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).at(-1))
}

test('window uses the most recent completed Wednesday boundary', () => {
  assert.deepEqual(computeEvolutionWindow(Date.parse('2026-09-02T08:30:00+08:00')), {
    startMs: Date.parse('2026-08-26T00:00:00+08:00'),
    endMs: Date.parse('2026-09-02T00:00:00+08:00'),
    startDate: '2026-08-26',
    endDate: '2026-09-02',
    reviewDate: '2026-09-02',
    memoryKey: 'reliable-evolution-weekly-20260902',
  })
})

test('lesson validator requires evidence and rejects weakened QA gates', () => {
  assert.equal(normalizeVerifiedLesson({ title: 'x', rule: '允许跳过QA验证直接交付', evidence: ['x'], verification: ['x'], source_refs: ['x'], anchor: 'x' }), null)
  assert.ok(normalizeVerifiedLesson({ title: 'x', rule: '同一失败指纹复现时先诊断', evidence: ['commit abc'], verification: ['node --test'], source_refs: ['test'], anchor: 'fp:abc' }))
})

test('default dry-run calls no model and leaves repository clean', () => {
  const data = fixture()
  const result = run(data, [])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(summary(result).status, 'dry-run')
  assert.equal(git(data.root, ['status', '--porcelain']), '')
})

test('safe proposal appends one lesson, commits only the learning file, and stays clean', () => {
  const data = fixture()
  const base = git(data.root, ['rev-parse', 'HEAD'])
  const result = run(data)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const payload = summary(result)
  assert.equal(payload.status, 'ok')
  assert.equal(payload.lessons_applied, 1)
  assert.notEqual(payload.commit, base)
  assert.equal(git(data.root, ['status', '--porcelain']), '')
  assert.equal(git(data.root, ['show', '--format=', '--name-only', 'HEAD']), 'skills/reliable-development/references/verified-weekly-learnings.md')

  const second = run(data)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(summary(second).status, 'reviewed_no_apply')
})

test('dirty repository skips without headless execution or mutation', () => {
  const data = fixture()
  writeFileSync(join(data.root, 'README.md'), 'dirty\n')
  const result = run(data)
  assert.equal(result.status, 0)
  assert.equal(summary(result).status, 'skipped_protected')
  assert.match(git(data.root, ['status', '--porcelain']), /README\.md/)
})

test('dangerous proposal is reviewed but never applied', () => {
  const data = fixture()
  const base = git(data.root, ['rev-parse', 'HEAD'])
  const result = run(data, ['--execute'], { DSH_EVOLUTION_FAKE_DANGEROUS: '1' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(summary(result).status, 'reviewed_no_apply')
  assert.equal(git(data.root, ['rev-parse', 'HEAD']), base)
  assert.equal(git(data.root, ['status', '--porcelain']), '')
})

test('headless repository mutation is rolled back and blocks the run', () => {
  const data = fixture()
  const result = run(data, ['--execute'], { DSH_EVOLUTION_FAKE_MUTATE: '1' })
  assert.notEqual(result.status, 0)
  assert.equal(summary(result).status, 'blocked')
  assert.equal(git(data.root, ['status', '--porcelain']), '')
})

test('validation failure restores learning file and keeps HEAD unchanged', () => {
  const data = fixture()
  const base = git(data.root, ['rev-parse', 'HEAD'])
  const result = run(data, ['--execute'], { DSH_EVOLUTION_TEST_VALIDATION_FAIL: '1' })
  assert.notEqual(result.status, 0)
  assert.equal(git(data.root, ['rev-parse', 'HEAD']), base)
  assert.equal(git(data.root, ['status', '--porcelain']), '')
})

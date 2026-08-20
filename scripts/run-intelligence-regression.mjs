#!/usr/bin/env node
/**
 * Deterministic, read-only regression orchestration for the intelligence work.
 * Each group is a separate child process with isolated data roots. A failure
 * never prevents later groups from running.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

export const DEFAULT_TIMEOUT_MS = 180_000

export const DEFAULT_FOCUSED_GROUPS = [
  { id: 'intelligence', category: 'data', testPath: 'extensions/dsh-intelligence/intelligence.test.mjs' },
  { id: 'memory-legacy', category: 'data', testPath: 'extensions/dsh-memory/index.test.mjs' },
  { id: 'memory-v2', category: 'data', testPath: 'extensions/dsh-memory/index.v2.test.mjs' },
  { id: 'compaction-v2', category: 'data', testPath: 'extensions/dsh-compaction-v2/compaction-v2.test.mjs' },
  { id: 'cross-session', category: 'data', testPath: 'extensions/dsh-cross-session/index.test.mjs' },
  { id: 'code-intelligence', category: 'code', testPath: 'extensions/dsh-code-intelligence/code-intelligence.test.mjs' },
  { id: 'frontend-qa', category: 'frontend', testPath: 'extensions/dsh-frontend-qa/frontend-qa.test.mjs' },
  { id: 'dsh-tool-policy', category: 'policy', testPath: 'extensions/dsh-tool-policy/index.test.mjs' },
  { id: 'evals', category: 'evals', testPath: 'extensions/dsh-evals/evals.test.mjs' },
  {
    id: 'direct-sample-suite-20',
    category: 'evals',
    evidenceLevel: '20 direct compaction + 20 TaskGraph restart/resume + 20 memory lifecycle + 20 cross-session module samples',
    command: ({ root, nodePath, sandbox }) => [nodePath, resolve(root, 'scripts/run-intelligence-sample-suite.mjs'), '--count', '20', '--allowed-root', sandbox.paths.root, '--output', 'direct-sample-suite.json'],
  },
  { id: 'skill-check', category: 'integrity', testPath: 'scripts/skill-check.test.mjs' },
  {
    id: 'reliable-development-preset',
    category: 'profile',
    evidenceLevel: 'reliable-development Compaction v2 isolation and model-policy contract',
    command: ({ root, nodePath }) => [nodePath, resolve(root, 'skills/reliable-development/scripts/verify_reliable_preset.mjs')],
  },
  { id: 'ui-integrity-focused-test', category: 'integrity', testPath: 'scripts/verify-ui-integrity.test.mjs' },
  { id: 'host-architecture-focused-test', category: 'integrity', testPath: 'scripts/verify-host-architecture.test.mjs' },
  { id: 'upgrade-readiness-focused-test', category: 'integrity', testPath: 'scripts/verify-upgrade-readiness.test.mjs' },
  { id: 'rollback-snapshot-focused-test', category: 'integrity', testPath: 'scripts/rollback-snapshot.test.mjs' },
  { id: 'web-intelligence-profile-focused-test', category: 'profile', testPath: 'profiles/web-intelligence/verify-profile.test.mjs' },
  { id: 'shrimp-shell-vision', category: 'host', testPath: 'extensions/shrimp-shell/vision.test.mjs' },
  {
    id: 'headless-profile',
    category: 'profile',
    evidenceLevel: 'config + package import + full Loader no-model task validation',
    fullLoaderAcceptance: true,
    note: 'No model/tool acceptance; real model acceptance is recorded separately by the parent flow',
    command: ({ root, nodePath }) => [nodePath, resolve(root, 'profiles/headless/verify-profile.mjs'), '--root', root, '--json', '--smoke'],
  },
]

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function isInside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))
}

export function chooseNodeBinary() {
  const preferred = '/usr/local/bin/node'
  return existsSync(preferred) ? preferred : process.execPath
}

export function createIsolatedDataRoots() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-intelligence-regression-'))
  const paths = {
    root,
    memoryRoot: join(root, 'memory'),
    memoryDb: join(root, 'memory', 'memory.sqlite'),
    intelligenceRoot: join(root, 'intelligence'),
    crossSessionDb: join(root, 'cross-session.sqlite'),
    codeIntelligenceRoot: join(root, 'code-intelligence'),
    compactionV2Root: join(root, 'compaction-v2'),
    evalsRoot: join(root, 'evals'),
  }
  for (const path of Object.values(paths).filter((value) => value !== root)) mkdirSync(path.endsWith('.sqlite') ? dirname(path) : path, { recursive: true })
  const env = {
    DSH_MEMORY_ROOT: paths.memoryRoot,
    DSH_MEMORY_DB: paths.memoryDb,
    DSH_INTELLIGENCE_ROOT: paths.intelligenceRoot,
    DSH_CROSS_SESSION_DB: paths.crossSessionDb,
    DSH_CODE_INTELLIGENCE_ROOT: paths.codeIntelligenceRoot,
    DSH_COMPACTION_V2_ROOT: paths.compactionV2Root,
    DSH_EVALS_ROOT: paths.evalsRoot,
  }
  return {
    paths,
    env,
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export function runCommand(command, { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const started = performance.now()
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  const durationMs = Math.round((performance.now() - started) * 100) / 100
  let status = 'passed'
  let error = null
  if (result.error) {
    error = { code: result.error.code ?? 'SPAWN_ERROR', message: result.error.message }
    status = result.error.code === 'ETIMEDOUT' || result.error.code === 'ENOENT' ? 'blocked' : 'failed'
  } else if (result.status !== 0) {
    status = 'failed'
  }
  return {
    command,
    commandText: command.map(shellQuote).join(' '),
    exitCode: result.status,
    signal: result.signal ?? null,
    durationMs,
    status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error,
  }
}

function groupCommand(group, { root, nodePath, sandbox }) {
  if (typeof group.command === 'function') return group.command({ root, nodePath, sandbox })
  return [nodePath, resolve(root, group.testPath), ...(group.args ?? [])]
}

function normalizeGroupStatus(status) {
  return new Set(['passed', 'failed', 'blocked']).has(status) ? status : 'failed'
}

export function runRegression({ root = process.cwd(), nodePath = chooseNodeBinary(), groups = DEFAULT_FOCUSED_GROUPS, uiManifest = null, execute = runCommand, createSandbox = createIsolatedDataRoots } = {}) {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const normalizedRoot = resolve(root)
  const reportGroups = []
  for (const group of groups) {
    const groupStarted = performance.now()
    let sandbox
    let sandboxCreationError
    try { sandbox = createSandbox(group) } catch (error) { sandboxCreationError = error }
    let groupResult
    if (sandboxCreationError) {
      groupResult = {
        command: null,
        commandText: null,
        exitCode: null,
        signal: null,
        durationMs: Math.round((performance.now() - groupStarted) * 100) / 100,
        status: 'failed',
        stdout: '',
        stderr: '',
        error: { code: sandboxCreationError?.code ?? 'SANDBOX_CREATE_FAILED', message: String(sandboxCreationError?.message || sandboxCreationError) },
      }
    } else try {
      const common = { root: normalizedRoot, nodePath, sandbox }
      const isUiBaseline = group.id === 'ui-integrity-check'
      if (isUiBaseline && !uiManifest) {
        groupResult = {
          command: null,
          commandText: null,
          exitCode: null,
          signal: null,
          durationMs: Math.round((performance.now() - groupStarted) * 100) / 100,
          status: 'blocked',
          stdout: '',
          stderr: '',
          error: { code: 'UI_BASELINE_NOT_SUPPLIED', message: 'formal UI baseline manifest was not supplied; record was not run' },
        }
      } else {
        const command = isUiBaseline
          ? [nodePath, resolve(normalizedRoot, 'scripts/verify-ui-integrity.mjs'), 'check', '--root', normalizedRoot, '--manifest', resolve(uiManifest), '--json']
          : groupCommand(group, common)
        groupResult = execute(command, {
          cwd: normalizedRoot,
          env: { ...process.env, ...sandbox.env },
          timeoutMs: group.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        })
      }
    } catch (error) {
      groupResult = {
        command: null,
        commandText: null,
        exitCode: null,
        signal: null,
        durationMs: Math.round((performance.now() - groupStarted) * 100) / 100,
        status: 'failed',
        stdout: '',
        stderr: '',
        error: { code: error?.code ?? 'ORCHESTRATOR_ERROR', message: String(error?.message || error) },
      }
    } finally {
      try { sandbox?.cleanup?.() } catch (error) {
        groupResult = { ...groupResult, status: 'failed', error: { code: 'CLEANUP_FAILED', message: String(error?.message || error) } }
      }
    }
    const durationMs = Math.round((performance.now() - groupStarted) * 100) / 100
    reportGroups.push({
      id: group.id,
      category: group.category ?? 'unspecified',
      testPath: group.testPath ?? null,
      ...groupResult,
      durationMs,
      isolatedRoots: sandbox?.paths ?? null,
      cleaned: true,
      evidenceLevel: group.evidenceLevel ?? 'focused-test',
      fullLoaderAcceptance: group.fullLoaderAcceptance ?? null,
      note: group.note ?? null,
      originalFailure: groupResult.status === 'passed' ? null : { error: groupResult.error, stdout: groupResult.stdout, stderr: groupResult.stderr, exitCode: groupResult.exitCode },
    })
  }
  const summary = {
    total: reportGroups.length,
    passed: reportGroups.filter((group) => group.status === 'passed').length,
    failed: reportGroups.filter((group) => group.status === 'failed').length,
    blocked: reportGroups.filter((group) => group.status === 'blocked').length,
  }
  const status = summary.failed > 0 ? 'failed' : (summary.blocked > 0 ? 'blocked' : 'passed')
  return {
    schemaVersion: 1,
    kind: 'deepseek-harness-intelligence-regression',
    root: normalizedRoot,
    nodePath,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    status,
    ok: status === 'passed',
    summary,
    groups: reportGroups,
  }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), json: false, output: null, allowedRoot: null, uiManifest: null }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--root') args.root = argv[++index]
    else if (token === '--json') args.json = true
    else if (token === '--output') args.output = argv[++index]
    else if (token === '--allowed-root') args.allowedRoot = argv[++index]
    else if (token === '--ui-manifest') args.uiManifest = argv[++index]
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`unknown option ${token}`)
  }
  if (!args.help && args.output && !args.allowedRoot) throw new Error('--output requires explicit --allowed-root; no output root is hard-coded')
  args.root = resolve(args.root)
  if (args.output) args.output = resolve(args.output.startsWith('/') ? args.output : resolve(args.allowedRoot), args.output)
  if (args.allowedRoot) args.allowedRoot = resolve(args.allowedRoot)
  return args
}

export function canonicalOutputPath({ output, allowedRoot } = {}) {
  if (!output || !allowedRoot) throw new Error('output and allowedRoot are required')
  const target = resolve(output)
  const lexicalRoot = resolve(allowedRoot)
  const root = realpathSync(lexicalRoot)
  if (!isInside(lexicalRoot, target)) throw new Error(`output escapes explicit allowedRoot: ${output}`)
  if (existsSync(target) && !isInside(root, realpathSync(target))) throw new Error(`output symlink escapes explicit allowedRoot: ${output}`)
  const parent = dirname(target)
  if (existsSync(parent) && !isInside(root, realpathSync(parent))) throw new Error(`output parent escapes explicit allowedRoot: ${output}`)
  return target
}

export function formatTextReport(report) {
  const lines = [`${report.kind}: ${report.status}`, `node: ${report.nodePath}`, `summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.blocked} blocked`]
  for (const group of report.groups) {
    lines.push(`${group.status.toUpperCase()} ${group.id} (${group.durationMs}ms)${group.exitCode === null ? '' : ` exit=${group.exitCode}`}`)
    if (group.error) lines.push(`  error: ${group.error.code ?? ''} ${group.error.message ?? ''}`)
    if (group.stderr) lines.push(`  stderr:\n${group.stderr}`)
    if (group.status !== 'passed' && group.stdout) lines.push(`  stdout:\n${group.stdout}`)
  }
  return lines.join('\n')
}

function writeReport(report, { json, output, allowedRoot }) {
  const text = json ? `${JSON.stringify(report, null, 2)}\n` : `${formatTextReport(report)}\n`
  if (output) {
    const target = canonicalOutputPath({ output, allowedRoot })
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text, 'utf8')
  }
  process.stdout.write(text)
}

export function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
    if (args.help) {
      console.log('Usage: node scripts/run-intelligence-regression.mjs [--json] [--root <path>] [--output <path> --allowed-root <path>] [--ui-manifest <path>]')
      return 0
    }
    const groups = [...DEFAULT_FOCUSED_GROUPS]
    groups.push({ id: 'ui-integrity-check', category: 'integrity' })
    groups.push({
      id: 'web-intelligence-profile',
      category: 'profile',
      evidenceLevel: 'config + full Loader + isolated ephemeral Web startup; no model/tool acceptance in this deterministic group',
      command: ({ root, nodePath }) => [nodePath, resolve(root, 'profiles/web-intelligence/verify-profile.mjs'), '--smoke'],
    })
    groups.push({
      id: 'upgrade-readiness-check',
      category: 'integrity',
      command: ({ root, nodePath }) => [nodePath, resolve(root, 'scripts/verify-upgrade-readiness.mjs'), '--root', root, '--json'],
    })
    groups.push({
      id: 'host-architecture-check',
      category: 'integrity',
      command: ({ root, nodePath }) => [nodePath, resolve(root, 'scripts/verify-host-architecture.mjs'), '--json'],
    })
    const report = runRegression({ root: args.root, uiManifest: args.uiManifest, groups })
    writeReport(report, args)
    return report.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main()

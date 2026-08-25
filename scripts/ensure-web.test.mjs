import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = resolve(import.meta.dirname, '..')
const ensureWeb = join(repoRoot, 'scripts', 'ensure-web')
const desktopSource = join(repoRoot, 'apps', '大神.swift')

function waitForFile(path, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}

test('大神.app uses ensure-web and ensure-web suppresses the external browser', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ensure-web-'))
  const dshHome = join(root, '.dsh')
  const argsPath = join(root, 'received-args.json')
  const binPath = join(dshHome, 'install', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const dependencyPath = join(dshHome, 'extensions', 'shrimp-shell', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')

  try {
    mkdirSync(resolve(binPath, '..'), { recursive: true })
    mkdirSync(resolve(dependencyPath, '..'), { recursive: true })
    mkdirSync(join(dshHome, 'scripts'), { recursive: true })
    writeFileSync(
      binPath,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));\n`,
      'utf8',
    )
    writeFileSync(dependencyPath, '{"name":"@deepseek-ai/dsh-tools"}\n', 'utf8')
    writeFileSync(join(dshHome, 'scripts', 'patch-subagent-selected-route.mjs'), 'process.exit(0)\n', 'utf8')

    const result = spawnSync('/bin/bash', [ensureWeb], {
      cwd: root,
      env: { ...process.env, HOME: root, DSH_PORT: '65431' },
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.deepEqual(JSON.parse(waitForFile(argsPath)), ['web', '--no-open'])

    const swift = readFileSync(desktopSource, 'utf8')
    assert.match(swift, /\.dsh\/scripts\/ensure-web/)
    assert.match(swift, /ensureService/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensure-web fails closed when the selected-route patch cannot run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ensure-web-route-fail-'))
  const dshHome = join(root, '.dsh')
  const binPath = join(dshHome, 'install', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const dependencyPath = join(dshHome, 'extensions', 'shrimp-shell', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  const patchPath = join(dshHome, 'scripts', 'patch-subagent-selected-route.mjs')
  try {
    mkdirSync(resolve(binPath, '..'), { recursive: true })
    mkdirSync(resolve(dependencyPath, '..'), { recursive: true })
    mkdirSync(join(dshHome, 'scripts'), { recursive: true })
    writeFileSync(binPath, 'process.exit(0)\n', 'utf8')
    writeFileSync(dependencyPath, '{"name":"@deepseek-ai/dsh-tools"}\n', 'utf8')
    writeFileSync(patchPath, 'process.exit(9)\n', 'utf8')

    const result = spawnSync('/bin/bash', [ensureWeb], {
      cwd: root,
      env: { ...process.env, HOME: root, DSH_PORT: '65432' },
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(readFileSync(join(dshHome, 'web.log'), 'utf8'), /refusing to start Host/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensure-web reload signature covers the complete CyberMarcus/runtime seam', () => {
  const source = readFileSync(ensureWeb, 'utf8')
  for (const path of [
    '$HOME/.dsh/settings.yaml',
    '$HOME/.dsh/.agent-presets/reliable-development/preset.yml',
    '$HOME/.dsh/profiles/web/package.json',
    '$HOME/.dsh/container.manifest.yaml',
    '$HOME/.dsh/extensions/dsh-goal-first-state-machine/index.js',
    '$HOME/.dsh/extensions/dsh-goal-first-state-machine/machine.js',
    '$HOME/.dsh/extensions/dsh-local-route-policy/index.js',
    '$HOME/.dsh/custom-ui-patches/dsh-client-ui-conversation/client.js.modified',
    '$HOME/.dsh/custom-ui-patches/dsh-client-ui-agent-preset/client.js.modified',
    '$HOME/.dsh/custom-ui-patches/dsh-client-ui-subagent/client.js.modified',
    '$HOME/.dsh/custom-ui-patches/dsh-client-ui-workspace/client.js.modified',
    '$HOME/.dsh/custom-ui-patches/shrimp-shell/index.js.modified',
    '$HOME/.dsh/custom-ui-patches/shrimp-shell/client.js.modified',
    '$HOME/.dsh/install/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js',
    '$HOME/.dsh/scripts/ensure-web',
    '$HOME/.dsh/scripts/patch-subagent-selected-route.mjs',
    '$HOME/.dsh/scripts/patch-llm-image-downcast.mjs',
    '$HOME/.dsh/scripts/patch-fs-edit-auto-observe.mjs',
    '$HOME/.dsh/scripts/daily-git-commit.mjs',
  ]) assert.match(source, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), path)
})

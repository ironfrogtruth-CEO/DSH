import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
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
  const knowledgeDependencyPath = join(dshHome, 'extensions', 'dsh-knowledge-manager', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')

  try {
    mkdirSync(resolve(binPath, '..'), { recursive: true })
    mkdirSync(resolve(dependencyPath, '..'), { recursive: true })
    mkdirSync(resolve(knowledgeDependencyPath, '..'), { recursive: true })
    mkdirSync(join(dshHome, 'scripts'), { recursive: true })
    writeFileSync(
      binPath,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));\n`,
      'utf8',
    )
    writeFileSync(dependencyPath, '{"name":"@deepseek-ai/dsh-tools"}\n', 'utf8')
    writeFileSync(knowledgeDependencyPath, '{"name":"@deepseek-ai/dsh-tools"}\n', 'utf8')
    writeFileSync(join(dshHome, 'scripts', 'patch-subagent-selected-route.mjs'), 'process.exit(0)\n', 'utf8')
    writeFileSync(join(dshHome, 'scripts', 'patch-avengers-model-default.mjs'), 'process.exit(0)\n', 'utf8')
    writeFileSync(join(dshHome, 'scripts', 'patch-client-command-actions.mjs'), 'process.exit(0)\n', 'utf8')
    writeFileSync(join(dshHome, 'scripts', 'replay-custom-ui-patches.mjs'), 'process.exit(0)\n', 'utf8')

    const result = spawnSync('/bin/bash', [ensureWeb], {
      cwd: root,
      env: { ...process.env, HOME: root, DSH_PORT: '65431' },
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.deepEqual(JSON.parse(waitForFile(argsPath)), ['web', '--no-open'])

    const swift = readFileSync(desktopSource, 'utf8')
    assert.match(swift, /\.dsh\/scripts\/(?:enable-host|ensure-web)/)
    assert.match(swift, /ensureService/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensure-web keeps homes without node-addon-require-builtin on the existing startup path', () => {
  const source = readFileSync(ensureWeb, 'utf8')
  assert.match(source, /INSTALL_NODE_MODULES="\$INSTALL_DIR\/node_modules"/)
  assert.match(source, /\[ -f "\$INSTALL_NODE_MODULES\/node-addon-require-builtin\/package\.json" \] \|\| return 0/)
  assert.match(source, /process\.arch/)
  assert.match(source, /--prefix "\$INSTALL_DIR" install --include=optional --ignore-scripts --no-audit --no-fund/)
  assert.match(source, /api\.requireBuiltin\('internal\/modules\/esm\/loader'\)/)
  assert.ok(
    source.indexOf('if ! ensure_internal_loader_binding; then') < source.indexOf('if ! ensure_profile_local_links; then'),
    'the architecture preflight must run before profile and Host startup work',
  )
})

test('ensure-web repairs or clearly blocks a missing Darwin optional binding before Host startup', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ensure-web-node-addon-binding-'))
  const dshHome = join(root, '.dsh')
  const install = join(dshHome, 'install')
  const nodeModules = join(install, 'node_modules')
  const entryManifest = join(nodeModules, 'node-addon-require-builtin', 'package.json')
  const bindingName = 'node-addon-require-builtin-darwin-(arm64|x64)'
  const npmArgs = join(root, 'npm-args.txt')
  const fakeNpm = join(root, 'npm')
  const hostArgs = join(root, 'host-args.json')
  const binPath = join(nodeModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  try {
    mkdirSync(resolve(binPath, '..'), { recursive: true })
    mkdirSync(resolve(entryManifest, '..'), { recursive: true })
    writeFileSync(binPath, `require('node:fs').writeFileSync(${JSON.stringify(hostArgs)}, JSON.stringify(process.argv.slice(2)))\n`)
    writeFileSync(entryManifest, JSON.stringify({
      name: 'node-addon-require-builtin',
      version: '0.1.5',
      optionalDependencies: {
        'node-addon-require-builtin-darwin-arm64': '0.1.5',
        'node-addon-require-builtin-darwin-x64': '0.1.5',
      },
    }))
    writeFileSync(join(install, 'package-lock.json'), JSON.stringify({ name: 'install', lockfileVersion: 3 }))
    writeFileSync(fakeNpm, [
      '#!/bin/bash',
      `printf '%s\\n' "$*" > ${JSON.stringify(npmArgs)}`,
      'exit 0',
    ].join('\n'))
    chmodSync(fakeNpm, 0o755)

    const result = spawnSync('/bin/bash', [ensureWeb], {
      cwd: root,
      env: { ...process.env, HOME: root, DSH_PORT: '65443', DSH_NPM_BIN: fakeNpm },
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    const log = readFileSync(join(dshHome, 'web.log'), 'utf8')
    assert.match(log, new RegExp(`DSH_NODE_ADDON_OPTIONAL_BINDING_MISSING\\t${bindingName}\\t`))
    assert.match(log, /DSH_NODE_ADDON_LOADER_FAILED after optional binding repair/)
    assert.equal(
      readFileSync(npmArgs, 'utf8').trim(),
      `--prefix ${install} install --include=optional --ignore-scripts --no-audit --no-fund`,
    )
    assert.equal(existsSync(hostArgs), false, 'Host must not start after an unverified binding repair')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensure-web fails closed when the selected-route patch cannot run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ensure-web-route-fail-'))
  const dshHome = join(root, '.dsh')
  const binPath = join(dshHome, 'install', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const dependencyPath = join(dshHome, 'extensions', 'shrimp-shell', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  const knowledgeDependencyPath = join(dshHome, 'extensions', 'dsh-knowledge-manager', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  const patchPath = join(dshHome, 'scripts', 'patch-subagent-selected-route.mjs')
  try {
    mkdirSync(resolve(binPath, '..'), { recursive: true })
    mkdirSync(resolve(dependencyPath, '..'), { recursive: true })
    mkdirSync(resolve(knowledgeDependencyPath, '..'), { recursive: true })
    mkdirSync(join(dshHome, 'scripts'), { recursive: true })
    writeFileSync(binPath, 'process.exit(0)\n', 'utf8')
    writeFileSync(dependencyPath, '{"name":"@deepseek-ai/dsh-tools"}\n', 'utf8')
    writeFileSync(knowledgeDependencyPath, '{"name":"@deepseek-ai/dsh-tools"}\n', 'utf8')
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

test('ensure-web fails closed when the Avengers baseline migration cannot run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ensure-web-avengers-route-fail-'))
  const dshHome = join(root, '.dsh')
  const binPath = join(dshHome, 'install', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const dependencyPath = join(dshHome, 'extensions', 'shrimp-shell', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  const knowledgeDependencyPath = join(dshHome, 'extensions', 'dsh-knowledge-manager', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  try {
    mkdirSync(resolve(binPath, '..'), { recursive: true })
    mkdirSync(resolve(dependencyPath, '..'), { recursive: true })
    mkdirSync(resolve(knowledgeDependencyPath, '..'), { recursive: true })
    mkdirSync(join(dshHome, 'scripts'), { recursive: true })
    writeFileSync(binPath, 'process.exit(0)\n', 'utf8')
    writeFileSync(dependencyPath, '{"name":"@deepseek-ai/dsh-tools"}\n', 'utf8')
    writeFileSync(knowledgeDependencyPath, '{"name":"@deepseek-ai/dsh-tools"}\n', 'utf8')
    writeFileSync(join(dshHome, 'scripts', 'patch-subagent-selected-route.mjs'), 'process.exit(0)\n', 'utf8')
    writeFileSync(join(dshHome, 'scripts', 'patch-avengers-model-default.mjs'), 'process.exit(9)\n', 'utf8')

    const result = spawnSync('/bin/bash', [ensureWeb], {
      cwd: root,
      env: { ...process.env, HOME: root, DSH_PORT: '65442' },
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(readFileSync(join(dshHome, 'web.log'), 'utf8'), /Avengers baseline restore failed; refusing to start Host/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensure-web repairs missing profile local links from the offline frozen lock exactly once', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ensure-web-profile-links-'))
  const dshHome = join(root, '.dsh')
  const profile = join(dshHome, 'profiles', 'web')
  const source = join(dshHome, 'extensions', 'example')
  const entry = join(profile, 'node_modules', '@local', 'example')
  const pnpmArgs = join(root, 'pnpm-args.txt')
  const fakePnpm = join(root, 'pnpm')
  const hostArgs = join(root, 'host-args.json')
  const binPath = join(dshHome, 'install', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const shrimpDependency = join(dshHome, 'extensions', 'shrimp-shell', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  const knowledgeDependency = join(dshHome, 'extensions', 'dsh-knowledge-manager', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  try {
    mkdirSync(resolve(binPath, '..'), { recursive: true })
    mkdirSync(resolve(shrimpDependency, '..'), { recursive: true })
    mkdirSync(resolve(knowledgeDependency, '..'), { recursive: true })
    mkdirSync(source, { recursive: true })
    mkdirSync(resolve(entry, '..'), { recursive: true })
    mkdirSync(join(dshHome, 'scripts'), { recursive: true })
    writeFileSync(join(source, 'package.json'), '{"name":"@local/example"}\n')
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { '@local/example': `link:${source}` } }))
    writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 6\n')
    writeFileSync(binPath, `require('node:fs').writeFileSync(${JSON.stringify(hostArgs)}, JSON.stringify(process.argv.slice(2)))\n`)
    writeFileSync(shrimpDependency, '{"name":"@deepseek-ai/dsh-tools"}\n')
    writeFileSync(knowledgeDependency, '{"name":"@deepseek-ai/dsh-tools"}\n')
    for (const name of ['patch-subagent-selected-route.mjs', 'patch-avengers-model-default.mjs', 'patch-client-command-actions.mjs', 'replay-custom-ui-patches.mjs']) {
      writeFileSync(join(dshHome, 'scripts', name), 'process.exit(0)\n')
    }
    writeFileSync(fakePnpm, [
      '#!/bin/bash',
      `printf '%s\\n' "$*" >> ${JSON.stringify(pnpmArgs)}`,
      'mkdir -p "$HOME/.dsh/profiles/web/node_modules/@local"',
      'ln -s "$HOME/.dsh/extensions/example" "$HOME/.dsh/profiles/web/node_modules/@local/example"',
    ].join('\n'))
    chmodSync(fakePnpm, 0o755)
    const env = { ...process.env, HOME: root, DSH_PNPM_BIN: fakePnpm }
    const first = spawnSync('/bin/bash', [ensureWeb], { cwd: root, env: { ...env, DSH_PORT: '65433' }, encoding: 'utf8', timeout: 5000 })
    assert.equal(first.status, 0, first.stderr || first.stdout)
    assert.equal(realpathSync(entry), realpathSync(source))
    assert.equal(readFileSync(pnpmArgs, 'utf8').trim(), 'install --offline --frozen-lockfile --ignore-scripts')
    assert.deepEqual(JSON.parse(waitForFile(hostArgs)), ['web', '--no-open'])

    const second = spawnSync('/bin/bash', [ensureWeb], { cwd: root, env: { ...env, DSH_PORT: '65434' }, encoding: 'utf8', timeout: 5000 })
    assert.equal(second.status, 0, second.stderr || second.stdout)
    assert.equal(readFileSync(pnpmArgs, 'utf8').trim().split('\n').length, 1, 'aligned links must not rerun pnpm')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensure-web fails closed when a declared profile local source is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ensure-web-profile-source-missing-'))
  const dshHome = join(root, '.dsh')
  const profile = join(dshHome, 'profiles', 'web')
  const binPath = join(dshHome, 'install', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  try {
    mkdirSync(resolve(binPath, '..'), { recursive: true })
    mkdirSync(profile, { recursive: true })
    writeFileSync(binPath, 'process.exit(0)\n')
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { '@local/missing': `link:${join(dshHome, 'extensions', 'missing')}` } }))
    const result = spawnSync('/bin/bash', [ensureWeb], {
      cwd: root,
      env: { ...process.env, HOME: root, DSH_PORT: '65435' },
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    const log = readFileSync(join(dshHome, 'web.log'), 'utf8')
    assert.match(log, /PROFILE_LOCAL_SOURCE_MISSING/)
    assert.match(log, /PROFILE_LOCAL_LINKS_MISSING/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensure-web reload signature covers the complete CyberMarcus and Avengers runtime seam', () => {
  const source = readFileSync(ensureWeb, 'utf8')
  for (const path of [
    '$HOME/.dsh/settings.yaml',
    '$HOME/.dsh/.agent-presets/reliable-development/preset.yml',
    '$HOME/.dsh/.agent-presets/avengers/preset.yml',
    '$HOME/.dsh/.agent-presets/avengers/agent.cordis.yml',
    '$HOME/.dsh/profiles/web/package.json',
    '$HOME/.dsh/container.manifest.yaml',
    '$HOME/.dsh/extensions/dsh-goal-first-state-machine/index.js',
    '$HOME/.dsh/extensions/dsh-goal-first-state-machine/machine.js',
    '$HOME/.dsh/extensions/dsh-local-route-policy/index.js',
    '$HOME/.dsh/extensions/dsh-tool-policy/index.js',
    '$HOME/.dsh/extensions/dsh-knowledge-manager/package.json',
    '$HOME/.dsh/extensions/dsh-knowledge-manager/index.js',
    '$HOME/.dsh/extensions/dsh-knowledge-manager/client.js',
    '$HOME/.dsh/extensions/dsh-knowledge-manager/cordis.patch.yml',
    '$HOME/.dsh/extensions/dsh-dingtalk-status/package.json',
    '$HOME/.dsh/extensions/dsh-dingtalk-status/index.js',
    '$HOME/.dsh/extensions/dsh-dingtalk-status/client.js',
    '$HOME/.dsh/extensions/dsh-dingtalk-status/cordis.patch.yml',
    '$HOME/.dsh/extensions/dsh-shrimp-run-status/package.json',
    '$HOME/.dsh/extensions/dsh-shrimp-run-status/index.js',
    '$HOME/.dsh/extensions/dsh-shrimp-run-status/client.js',
    '$HOME/.dsh/extensions/dsh-shrimp-run-status/model.mjs',
    '$HOME/.dsh/extensions/dsh-shrimp-run-status/cordis.patch.yml',
    '$HOME/.dsh/extensions/dsh-webbridge/package.json',
    '$HOME/.dsh/extensions/dsh-webbridge/index.js',
    '$HOME/.dsh/extensions/dsh-webbridge/cordis.patch.yml',
    '$HOME/.dsh/extensions/dsh-webbridge/native-host/nm-host.js',
    '$HOME/.dsh/profiles/web/cordis.patch.yml',
    '$HOME/.dsh/profiles/web/pnpm-lock.yaml',
    '$HOME/.dsh/custom-ui-patches/dsh-client-ui-jobs/client.js.modified',
    '$HOME/.dsh/custom-ui-patches/dsh-client-ui-conversation/client.js.modified',
    '$HOME/.dsh/custom-ui-patches/dsh-client-ui-agent-preset/client.js.modified',
    '$HOME/.dsh/custom-ui-patches/dsh-client-ui-subagent/client.js.rc2-archive.modified',
    '$HOME/.dsh/custom-ui-patches/dsh-client-ui-workspace/client.js.modified',
    '$HOME/.dsh/custom-ui-patches/shrimp-shell/index.js.modified',
    '$HOME/.dsh/custom-ui-patches/shrimp-shell/client.js.modified',
    '$HOME/.dsh/install/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js',
    '$HOME/.dsh/install/node_modules/@deepseek-ai/dsh-client-ui-jobs/lib/client.js',
    '$HOME/.dsh/install/node_modules/@deepseek-ai/dsh-client-ui-commands/lib/client.js',
    '$HOME/.dsh/install/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js',
    '$HOME/.dsh/install/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js',
    '$HOME/.dsh/scripts/ensure-web',
    '$HOME/.dsh/scripts/start-local-model-runtime',
    '$HOME/.dsh/scripts/patch-subagent-selected-route.mjs',
    '$HOME/.dsh/scripts/patch-avengers-model-default.mjs',
    '$HOME/.dsh/scripts/patch-client-command-actions.mjs',
    '$HOME/.dsh/scripts/patch-tool-call-presentation-titles.mjs',
    '$HOME/.dsh/scripts/replay-custom-ui-patches.mjs',
    '$HOME/.dsh/scripts/patch-llm-image-downcast.mjs',
    '$HOME/.dsh/scripts/patch-fs-edit-auto-observe.mjs',
    '$HOME/.dsh/scripts/daily-git-commit.mjs',
]) assert.match(source, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), path)
  assert.doesNotMatch(source, /custom-ui-patches\/dsh-client-ui-subagent\/client\.js\.modified/)
  assert.doesNotMatch(source, /dsh-imessage-bridge/)
})

test('ensure-web restores the exact DingTalk profile dependency without lifecycle scripts', () => {
  const source = readFileSync(ensureWeb, 'utf8')
  assert.match(source, /DINGTALK_PACKAGE=.*@dingtalk-real-ai\/dsh-dingtalk\/package\.json/)
  assert.match(source, /install --frozen-lockfile --ignore-scripts/)
  assert.doesNotMatch(source, /IMESSAGE_BRIDGE_DIR|iMessage bridge 依赖安装失败/)
})

test('ensure-web validates goal-first contracts before stopping a healthy Host', () => {
  const source = readFileSync(ensureWeb, 'utf8')
  assert.match(source, /GOAL_FIRST_PREFLIGHT=.*goal-first-state-machine\.test\.mjs/)
  assert.match(source, /node --test "\$GOAL_FIRST_PREFLIGHT"/)
  assert.match(source, /goal-first preflight failed; keeping current Host/)
  assert.ok(
    source.indexOf('node --test "$GOAL_FIRST_PREFLIGHT"') < source.indexOf('"$HOME/.dsh/scripts/stop"'),
    'candidate validation must run before the current Host is stopped',
  )
})

test('大神 local auxiliary model bootstrap uses the project root and only requires EmbeddingGemma', () => {
  const source = readFileSync(join(repoRoot, 'scripts', 'start-local-model-runtime'), 'utf8')
  assert.match(source, /MODEL_ROOT="\/Users\/marcus\/Desktop\/虾缸\/MODEL"/)
  assert.match(source, /OLLAMA_MODELS_ROOT="\$MODEL_ROOT\/ollama\/models"/)
  assert.match(source, /embeddinggemma:latest/)
  assert.doesNotMatch(source, /cybermarcus:latest|glm-marcus:latest|gemma4:26b-a4b-it-qat/)
  assert.match(source, /launchctl setenv OLLAMA_MODELS/)
  assert.match(readFileSync(ensureWeb, 'utf8'), /scripts\/start-local-model-runtime/)
})

test('ensure-web replays reviewed client UI patches before Host startup', () => {
  const source = readFileSync(ensureWeb, 'utf8')
  assert.match(source, /scripts\/replay-custom-ui-patches\.mjs" --apply/)
  assert.match(source, /custom UI patch replay failed; refusing to start Host/)
  assert.match(source, /TOOL_TITLE_PATCH="\$HOME\/\.dsh\/scripts\/patch-tool-call-presentation-titles\.mjs"/)
  assert.match(source, /node "\$TOOL_TITLE_PATCH" --apply/)
  assert.match(source, /tool presentation title patch failed; refusing to start Host/)
  assert.match(source, /AVENGERS_BASELINE="\$HOME\/\.dsh\/scripts\/patch-avengers-model-default\.mjs"/)
  assert.match(source, /node "\$AVENGERS_BASELINE" --apply/)
  assert.match(source, /node "\$AVENGERS_BASELINE" --check/)
  assert.match(source, /Avengers baseline restore failed; refusing to start Host/)
  assert.match(source, /Avengers baseline check failed; refusing to start Host/)
})

test('foreground ensure-web releases startup lock after bind while keeping the Host owner alive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ensure-web-foreground-'))
  const dshHome = join(root, '.dsh')
  const port = '65441'
  const binPath = join(dshHome, 'install', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const dependencyPath = join(dshHome, 'extensions', 'shrimp-shell', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  const knowledgeDependencyPath = join(dshHome, 'extensions', 'dsh-knowledge-manager', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  const runnerPath = join(dshHome, 'scripts', 'run-web-pty.py')
  const subagentPatch = join(dshHome, 'scripts', 'patch-subagent-selected-route.mjs')
  const avengersModelPatch = join(dshHome, 'scripts', 'patch-avengers-model-default.mjs')
  const commandActionsPatch = join(dshHome, 'scripts', 'patch-client-command-actions.mjs')
  const replayUiPatches = join(dshHome, 'scripts', 'replay-custom-ui-patches.mjs')
  let child
  try {
    mkdirSync(resolve(binPath, '..'), { recursive: true })
    mkdirSync(resolve(dependencyPath, '..'), { recursive: true })
    mkdirSync(resolve(knowledgeDependencyPath, '..'), { recursive: true })
    mkdirSync(join(dshHome, 'scripts'), { recursive: true })
    writeFileSync(binPath, [
      "const http = require('node:http')",
      "const server = http.createServer((_, res) => { res.end('ok') })",
      "server.listen(Number(process.env.DSH_PORT), '127.0.0.1')",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)))",
      "setInterval(() => {}, 1000)",
    ].join('\n'), 'utf8')
    writeFileSync(dependencyPath, '{"name":"@deepseek-ai/dsh-tools"}\n', 'utf8')
    writeFileSync(knowledgeDependencyPath, '{"name":"@deepseek-ai/dsh-tools"}\n', 'utf8')
    writeFileSync(subagentPatch, 'process.exit(0)\n', 'utf8')
    writeFileSync(avengersModelPatch, 'process.exit(0)\n', 'utf8')
    writeFileSync(commandActionsPatch, 'process.exit(0)\n', 'utf8')
    writeFileSync(replayUiPatches, 'process.exit(0)\n', 'utf8')
    writeFileSync(runnerPath, readFileSync(join(repoRoot, 'scripts', 'run-web-pty.py')))
    chmodSync(runnerPath, 0o755)

    const env = { ...process.env, HOME: root, DSH_PORT: port, DSH_FOREGROUND: '1' }
    child = spawn('/bin/bash', [ensureWeb], { cwd: root, env, stdio: 'ignore' })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const probe = spawnSync('/usr/sbin/lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' })
      if (probe.status === 0 && probe.stdout.trim()) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const listener = spawnSync('/usr/sbin/lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' })
    assert.equal(listener.status, 0, 'foreground Host did not bind test port')
    const lockPath = join(dshHome, 'private', 'ensure-web.lock')
    const lockDeadline = Date.now() + 2000
    while (existsSync(lockPath) && Date.now() < lockDeadline) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(existsSync(lockPath), false, 'startup lock must be released after bind')
    const second = spawnSync('/bin/bash', [ensureWeb], { cwd: root, env: { ...env, DSH_FOREGROUND: '0' }, encoding: 'utf8', timeout: 3000 })
    assert.equal(second.status, 0, second.stderr || second.stdout)
    assert.equal(child.exitCode, null, 'foreground owner must remain alive after lock release')
  } finally {
    const listener = spawnSync('/usr/sbin/lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' })
    for (const value of listener.stdout.split(/\s+/).filter(Boolean)) {
      try { process.kill(Number(value), 'SIGTERM') } catch { /* already exited */ }
    }
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))])
    }
    rmSync(root, { recursive: true, force: true })
  }
})

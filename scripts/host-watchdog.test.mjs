import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = resolve(import.meta.dirname, '..')
const watchdog = join(repoRoot, 'scripts', 'host-watchdog')
const stateScript = join(repoRoot, 'scripts', 'host-service-state')
const installScript = join(repoRoot, 'scripts', 'install-host-watchdog')
const plistTemplate = join(repoRoot, 'scripts', 'com.shrimptank.dashen.host-watchdog.plist.template')

function tempHome(label) {
  const root = join(tmpdir(), `dsh-watchdog-${label}-${process.pid}-${Date.now()}`)
  mkdirSync(join(root, '.dsh', 'scripts'), { recursive: true })
  return root
}

test('service sentinel is atomic, explicit-quit persistent, and app enable clears it', () => {
  const home = tempHome('sentinel')
  try {
    const env = { ...process.env, HOME: home }
    assert.equal(spawnSync('/bin/bash', [stateScript, 'disable'], { env }).status, 0)
    const sentinel = join(home, '.dsh', 'private', 'service-disabled')
    assert.equal(existsSync(sentinel), true)
    assert.equal(spawnSync('/bin/bash', [stateScript, 'is-disabled'], { env }).status, 0)
    assert.equal(spawnSync('/bin/bash', [stateScript, 'enable'], { env }).status, 0)
    assert.equal(existsSync(sentinel), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('watchdog does not revive an explicitly quit Host and requests hidden App recovery when absent', () => {
  const home = tempHome('dispatch')
  const sentinel = join(home, '.dsh', 'private', 'background-launch')
  try {
    const scriptDir = join(home, '.dsh', 'scripts')
    writeFileSync(join(scriptDir, 'host-service-state'), readFileSync(stateScript))
    spawnSync('/bin/chmod', ['755', join(scriptDir, 'host-service-state')])
    const env = { ...process.env, HOME: home, DSH_PORT: '65439', DSH_APP_PATH: '/tmp/dashen-test.app', DSH_APP_BINARY: '/tmp/dashen-test.app/Contents/MacOS/大神', DSH_OPEN_CMD: '/bin/echo' }
    assert.equal(spawnSync('/bin/bash', [watchdog], { env }).status, 0)
    assert.equal(existsSync(sentinel), true)
    assert.equal(readFileSync(sentinel, 'utf8').length > 0, true)
    assert.equal(statSync(sentinel).mode & 0o777, 0o600)
    assert.equal(spawnSync('/bin/bash', [stateScript, 'disable'], { env }).status, 0)
    assert.equal(spawnSync('/bin/bash', [watchdog], { env }).status, 0)
    assert.equal(existsSync(sentinel), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('watchdog and ensure-web encode one-listener locking and no KeepAlive launchd policy', () => {
  const source = readFileSync(watchdog, 'utf8')
  const ensure = readFileSync(join(repoRoot, 'scripts', 'ensure-web'), 'utf8')
  const plist = readFileSync(plistTemplate, 'utf8')
  assert.match(source, /lsof -tiTCP:/)
  assert.match(source, /COUNT=.*awk/)
  assert.match(source, /refusing to touch duplicate listeners/)
  assert.doesNotMatch(source, /ensure-web/)
  assert.match(source, /pgrep -f "\$APP_BINARY"/)
  assert.match(source, /background-launch/)
  assert.match(source, /"\$OPEN_CMD" -gj "\$APP_PATH"/)
  assert.match(ensure, /mkdir "\$LOCK_DIR"/)
  assert.match(ensure, /DSH_FORCE_RESTART/)
  assert.match(ensure, /DSH_FOREGROUND/)
  assert.match(ensure, /HOST_PID=\$!/)
  assert.match(ensure, /release_lock[\s\S]*wait "\$HOST_PID"/)
  assert.ok(ensure.indexOf('release_lock') < ensure.indexOf('wait "$HOST_PID"'), 'foreground lock must release before wait')
  assert.match(ensure, /PYTHON_RUNNER=/)
  assert.match(ensure, /Python\.app/)
  assert.match(ensure, /Contents.*MacOS.*Python/)
  assert.match(ensure, /"\$PYTHON_RUNNER" "\$PTY_RUNNER"/)
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>/)
  assert.match(plist, /<key>RunAtLoad<\/key>/)
  assert.match(plist, /<key>StartInterval<\/key>/)
  assert.match(plist, /<integer>30<\/integer>/)
  assert.match(readFileSync(installScript, 'utf8'), /launchctl bootstrap/)
})

test('watchdog discovers the installed App before stale Desktop copies', () => {
  const source = readFileSync(watchdog, 'utf8')
  assert.match(source, /-d "\/Applications\/大神\.app"/)
  assert.match(source, /APP_PATH="\/Applications\/大神\.app"/)
  assert.match(source, /APP_NAME="\$\(basename "\$APP_PATH" \.app\)"/)
  assert.doesNotMatch(source, /DSH_APP_PATH:-\/Users\/marcus\/Desktop\/大神\.app/)
})

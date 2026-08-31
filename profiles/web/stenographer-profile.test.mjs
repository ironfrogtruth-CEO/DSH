import assert from 'node:assert/strict'
import { realpath, readFile } from 'node:fs/promises'
import test from 'node:test'

const profileRoot = '/Users/marcus/.dsh/profiles/web'
const extensionRoot = '/Users/marcus/.dsh/extensions/dsh-stenographer'
const pkg = JSON.parse(await readFile(`${profileRoot}/package.json`, 'utf8'))
const ensureWeb = await readFile('/Users/marcus/.dsh/scripts/ensure-web', 'utf8')
const containerManifest = await readFile('/Users/marcus/.dsh/container.manifest.yaml', 'utf8')

test('web profile loads the independent stenographer before the final shrimp-shell bridge', async () => {
  assert.equal(pkg.dependencies['@local/dsh-stenographer'], `link:${extensionRoot}`)
  const bundles = pkg.dsh.profile.bundles
  const stenographer = bundles.indexOf('@local/dsh-stenographer')
  const shrimpShell = bundles.indexOf('@local/dsh-shrimp-shell')
  assert.ok(stenographer >= 0)
  assert.ok(shrimpShell > stenographer, 'shrimp-shell remains the final visual bridge')
  assert.equal(await realpath(`${profileRoot}/node_modules/@local/dsh-stenographer`), await realpath(extensionRoot))
})

test('host reload signature and preflight cover the complete stenographer seam', () => {
  for (const value of [
    'extensions/dsh-stenographer/package.json',
    'extensions/dsh-stenographer/index.js',
    'extensions/dsh-stenographer/client.js',
    'runtime/model-supervisor.js',
    'runtime/service.js',
    'runtime/speaker-cluster.js',
    'scripts/stt_worker.py',
    'scripts/paraformer_worker.py',
    'scripts/speaker_worker.py',
    'runtimes/stenographer/models/manifest.json',
  ]) assert.ok(ensureWeb.includes(value), `signature missing ${value}`)
  assert.match(ensureWeb, /stenographer preflight failed; keeping current Host/)
  assert.match(containerManifest, /@local\/dsh-stenographer/)
})

test('speech recognition has no cloud fallback and writing is pinned to GLM-5.3-Flash', async () => {
  const source = JSON.stringify(pkg)
  assert.doesNotMatch(source, /pyannoteAI|openai-api|paid-stt|cloud-diarization/i)
  const runtime = await readFile(`${extensionRoot}/runtime/constants.js`, 'utf8')
  assert.match(runtime, /provider: 'zhipu-glm'/)
  assert.match(runtime, /model: 'glm-5\.3-flash'/)
  assert.match(runtime, /paidApiFallback: false/)
})

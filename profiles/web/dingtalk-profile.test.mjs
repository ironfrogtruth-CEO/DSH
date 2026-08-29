import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const profileUrl = new URL('./package.json', import.meta.url)
const patchUrl = new URL('./cordis.patch.yml', import.meta.url)
const lockUrl = new URL('./pnpm-lock.yaml', import.meta.url)
const npmrcUrl = new URL('./.npmrc', import.meta.url)
const runtimePatchUrl = new URL('./patches/@dingtalk-real-ai__dsh-dingtalk@0.6.2.patch', import.meta.url)
const balanceUrl = new URL('../../extensions/dsbalance-bundle/client.js', import.meta.url)

test('web profile keeps the original balance bundle and uses the pinned DingTalk status seam', async () => {
  const [profile, patch, lock, npmrc, runtimePatch, balance] = await Promise.all([
    readFile(profileUrl, 'utf8').then(JSON.parse),
    readFile(patchUrl, 'utf8'),
    readFile(lockUrl, 'utf8'),
    readFile(npmrcUrl, 'utf8'),
    readFile(runtimePatchUrl, 'utf8'),
    readFile(balanceUrl, 'utf8'),
  ])
  assert.equal(profile.dependencies['@dingtalk-real-ai/dsh-dingtalk'], '0.6.2')
  assert.equal(profile.pnpm?.patchedDependencies?.['@dingtalk-real-ai/dsh-dingtalk@0.6.2'], 'patches/@dingtalk-real-ai__dsh-dingtalk@0.6.2.patch')
  assert.equal(profile.dependencies['@local/dsh-dingtalk-status'], 'link:/Users/marcus/.dsh/extensions/dsh-dingtalk-status')
  assert.equal(profile.dependencies['@local/dsh-imessage-bridge'], undefined)
  assert.ok(profile.dsh.profile.bundles.includes('@local/dsh-dsbalance'))
  assert.ok(profile.dsh.profile.bundles.includes('@dingtalk-real-ai/dsh-dingtalk'))
  assert.ok(profile.dsh.profile.bundles.includes('@local/dsh-dingtalk-status'))
  assert.equal(profile.dsh.profile.bundles.includes('@local/dsh-imessage-bridge'), false)

  assert.match(patch, /id: dingtalk-channel/)
  assert.match(patch, /workspace: \/Users\/marcus\/Desktop/)
  assert.match(patch, /senderAccess: owner/)
  assert.match(patch, /groupAccess: none/)
  assert.match(patch, /imageMode: auto/)
  assert.match(patch, /tools:\s*\n\s+enabled: false/)
  assert.match(patch, /debug: false/)
  assert.match(patch, /consoleCardTemplateId: f42ee85c-bdb9-4197-b8b7-4379e9b64878\.schema/)
  assert.match(patch, /id: dsh-dingtalk-status/)
  assert.match(patch, /clientIdRef: DINGTALK_CLIENT_ID/)
  assert.match(patch, /clientSecretRef: DINGTALK_CLIENT_SECRET/)
  assert.doesNotMatch(patch, /^\s*(?:clientId|clientSecret|ownerStaffId):/im)
  assert.doesNotMatch(patch, /bind\s+[^#\n]+/i)

  assert.match(lock, /['"]?@dingtalk-real-ai\/dsh-dingtalk['"]?:\s*\n\s+specifier: 0\.6\.2/)
  assert.match(lock, /\/\@dingtalk-real-ai\/dsh-dingtalk@0\.6\.2/)
  assert.match(lock, /dingtalk-stream:/)
  assert.match(lock, /patchedDependencies:/)
  assert.match(lock, /patch_hash=/)
  assert.doesNotMatch(lock, /@local\/dsh-imessage-bridge/)
  assert.match(npmrc, /^registry=https:\/\/registry\.npmjs\.org\/$/m)
  assert.match(npmrc, /^ignore-workspace-root-check=true$/m)
  for (const contract of ['/menu', '/sessions', '/session use', '/artifacts', '/models', '/effort']) assert.match(runtimePatch, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(runtimePatch, /DINGTALK_ROUTE_TTL_MS/)
  assert.match(runtimePatch, /source\?\.kind === 'user'/)
  assert.match(runtimePatch, /sessionQuery/)
  assert.match(runtimePatch, /listSessions\(\)/)
  assert.match(runtimePatch, /resolveCallConfig/)
  assert.match(runtimePatch, /consoleCardTemplateId/)
  assert.match(runtimePatch, /submit_form_fields/)
  assert.match(runtimePatch, /userPrivateData/)

  // User explicitly overrode the earlier balance redesign: preserve its
  // complete row, link and visible text contract.
  assert.match(balance, /topUpUrl: /)
  assert.match(balance, /'充值 ↗'/)
  assert.match(balance, /const className = ok \? .*dsbalance-card/)
})

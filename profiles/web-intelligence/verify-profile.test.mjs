import test from 'node:test'
import assert from 'node:assert/strict'
import { verify } from './verify-profile.mjs'

test('web-intelligence candidate keeps current Web bundles and Host-only intelligence composition', async () => {
  const result = await verify({ runSmoke: false })
  assert.equal(result.profile, 'web-intelligence')
  assert.equal(result.defaultProfileChanged, false)
  assert.equal(result.profileCompactionProvider, null)
  assert.equal(result.reliableDevelopmentCompactionTarget, '@local/dsh-compaction-v2')
  assert.ok(result.hostRows.includes('@local/dsh-intelligence'))
  assert.ok(result.bundles.includes('@deepseek-ai/dsh-web-app'))
})

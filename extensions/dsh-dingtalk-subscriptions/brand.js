import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BRAND_ASSET_PATH = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'dashen-bot-avatar.png')
export const BRAND_MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'brand-manifest.json')
export const BRAND_AVATAR_SHA256 = '380efb54e7271281ddf4fac530915c03cbf90fb4bb2e01fc62d838c2aa7ce1ff'

export function brandAssetSha256(path = BRAND_ASSET_PATH) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function verifyBrandAsset(path = BRAND_ASSET_PATH) {
  const digest = brandAssetSha256(path)
  return { ok: digest === BRAND_AVATAR_SHA256, path, sha256: digest, width: 512, height: 512, transparent: true, borderless: true }
}

export const BRAND_ASSET = Object.freeze({ path: BRAND_ASSET_PATH, sha256: BRAND_AVATAR_SHA256, width: 512, height: 512, transparent: true, borderless: true })

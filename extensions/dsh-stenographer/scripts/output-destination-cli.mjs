#!/usr/bin/env node
/**
 * output-destination-cli — stdin/stdout adapter for the unified final-output
 * router used by 虾缸's `backend/domain/output_destination.py`.
 *
 * Rebuilt 2026-09-09 after the original CLI script was lost from this
 * extension directory (the restored `output-destination.mjs` policy module
 * beside this file is the same implementation that shipped before).
 *
 * Contract:
 *   stdin  : JSON payload (snake_case) from _router_payload /
 *            _router_bundle_payload
 *   stdout : JSON result — single object for one file, array for a bundle,
 *            each entry carrying preferred_path/actual_path/storage_tier/
 *            fallback_reason/sync_status/cloud_sync_confirmed (+bundle fields)
 *   stderr : one JSON line {code,message} and exit 1 on failure
 */
import { readFile } from 'node:fs/promises'
import {
  routeFinalBundle,
  routeFinalOutput,
} from './output-destination.mjs'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ code, message })}\n`)
  process.exit(1)
}

async function main() {
  const raw = (await readStdin()).trim()
  if (!raw) fail('OUTPUT_ROUTER_INPUT_REQUIRED', '路由器缺少入参')
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    fail('OUTPUT_ROUTER_INPUT_INVALID', '路由器入参不是合法 JSON')
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('OUTPUT_ROUTER_INPUT_INVALID', '路由器入参必须是对象')
  }

  const common = {
    theme: payload.theme || '默认',
    preferredRoot: payload.preferred_root || undefined,
    fallbackRoot: payload.fallback_root || undefined,
  }

  try {
    if (Array.isArray(payload.files)) {
      const files = payload.files.map((item) => ({
        sourcePath: item?.source_path,
        relativePath: item?.relative_path ?? item?.file_name ?? item?.name,
      }))
      const result = await routeFinalBundle({
        ...common,
        files,
        bundleId: payload.bundle_id || '',
      })
      process.stdout.write(JSON.stringify(result))
      return
    }

    const source = payload.bytes_base64
      ? { bytes: Buffer.from(String(payload.bytes_base64), 'base64') }
      : { sourcePath: payload.source_path }
    if (!source.bytes && !source.sourcePath) {
      fail('OUTPUT_SOURCE_REQUIRED', '缺少成品 source_path 或 data')
    }
    const result = await routeFinalOutput({
      ...common,
      ...source,
      fileName: payload.file_name || '成品.bin',
    })
    process.stdout.write(JSON.stringify(result))
  } catch (error) {
    fail(String(error?.code || 'OUTPUT_ROUTER_FAILED'), String(error?.message || error))
  }
}

main().catch((error) => fail(String(error?.code || 'OUTPUT_ROUTER_FAILED'), String(error?.message || error)))

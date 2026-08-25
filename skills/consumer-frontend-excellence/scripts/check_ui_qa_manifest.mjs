#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const target = process.argv[2]
if (!target) throw new Error('usage: check_ui_qa_manifest.mjs <ui-qa.json>')
const path = resolve(target)
const data = JSON.parse(readFileSync(path, 'utf8'))

assert.equal(data.schema, 'consumer-ui-qa.v1')
assert.equal(data.consoleErrors, 0, 'consoleErrors must be 0')
assert.equal(data.pageErrors, 0, 'pageErrors must be 0')
assert.equal(data.horizontalOverflow, false, 'horizontal overflow detected')
assert.deepEqual(data.clippedCriticalRegions || [], [], 'critical regions are clipped')
assert.ok(Array.isArray(data.functionalChecks) && data.functionalChecks.length > 0, 'functionalChecks required')
assert.ok(data.functionalChecks.every((item) => item && item.passed === true), 'a functional check failed')
assert.ok(Array.isArray(data.screens) && data.screens.length > 0, 'screens required')

for (const screen of data.screens) {
  assert.ok(Number.isInteger(screen.width) && screen.width > 0, 'screen width invalid')
  assert.ok(Number.isInteger(screen.height) && screen.height > 0, 'screen height invalid')
  assert.ok(['light', 'dark', 'system'].includes(screen.theme), 'screen theme invalid')
  assert.ok(typeof screen.state === 'string' && screen.state.trim(), 'screen state required')
  assert.ok(typeof screen.screenshot === 'string' && existsSync(resolve(screen.screenshot)), `missing screenshot: ${screen.screenshot}`)
  assert.equal(screen.reviewed, true, `screenshot not reviewed: ${screen.screenshot}`)
}

assert.equal(data.visualReview?.passed, true, 'visual review has not passed')
assert.ok(typeof data.visualReview?.notes === 'string' && data.visualReview.notes.trim(), 'visual review notes required')
console.log(`consumer UI QA: OK (${data.screens.length} screens, ${data.functionalChecks.length} functional checks)`)

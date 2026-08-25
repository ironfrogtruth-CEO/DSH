import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { atomicReplaceFile, LEGACY_MARKER, MARKER, PATCH_TEXT, patchSubagentSelectedRoute, SUPPORTED_VERSION } from './patch-subagent-selected-route.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
const sourcePackage = path.join(repoRoot, 'install/node_modules/@deepseek-ai/dsh-subagent')

function restoreBaseline() {
	let index = readFileSync(path.join(sourcePackage, 'lib/index.js'), 'utf8')
	if (index.includes(MARKER)) {
		index = index.replace(PATCH_TEXT.indexResolverV2, PATCH_TEXT.indexResolverOld)
			.replace(PATCH_TEXT.continuableRouteV2, PATCH_TEXT.continuableRouteOld)
	}
	const invariant = readFileSync(path.join(sourcePackage, 'lib/invariant.js'), 'utf8')
	assert.ok(!invariant.includes(MARKER), 'installed invariant must be restored to rc.2 baseline before fixture construction')
	return { index, invariant }
}

function makeFixture(kind = 'baseline') {
	const root = mkdtempSync(path.join(tmpdir(), 'dsh-selected-route-'))
	const packageRoot = path.join(root, 'node_modules/@deepseek-ai/dsh-subagent')
	mkdirSync(path.join(packageRoot, 'lib'), { recursive: true })
	const baseline = restoreBaseline()
	copyFileSync(path.join(sourcePackage, 'package.json'), path.join(packageRoot, 'package.json'))
	let index = baseline.index
	let invariant = baseline.invariant
	if (kind === 'v1') {
		index = index.replace(PATCH_TEXT.indexImportOld, PATCH_TEXT.indexImportV1)
			.replace(PATCH_TEXT.indexResolverOld, PATCH_TEXT.indexResolverV1)
			.replace(PATCH_TEXT.continuableRouteOld, PATCH_TEXT.continuableRouteV1)
		invariant = invariant.replace(PATCH_TEXT.invariantExportOld, PATCH_TEXT.legacyInvariantExport)
	} else if (kind === 'v2-semi') {
		index = index.replace(PATCH_TEXT.indexResolverOld, PATCH_TEXT.indexResolverV2)
			.replace(PATCH_TEXT.continuableRouteOld, PATCH_TEXT.continuableRouteV2)
		invariant = invariant.replace(PATCH_TEXT.invariantExportOld, PATCH_TEXT.legacyInvariantExport)
	} else if (kind !== 'baseline') {
		throw new Error(`unknown fixture kind ${kind}`)
	}
	writeFileSync(path.join(packageRoot, 'lib/index.js'), index, 'utf8')
	writeFileSync(path.join(packageRoot, 'lib/invariant.js'), invariant, 'utf8')
	const dependencyRoot = path.join(root, 'node_modules/@deepseek-ai')
	mkdirSync(dependencyRoot, { recursive: true })
	for (const packageName of ['cordis', 'dsh-scope', 'dsh-tools', 'dsh-llm', 'dsh-agent', 'dsh-session']) {
		symlinkSync(path.join(repoRoot, 'install/node_modules/@deepseek-ai', packageName), path.join(dependencyRoot, packageName), 'dir')
	}
	symlinkSync(path.join(repoRoot, 'install/node_modules/zod'), path.join(root, 'node_modules/zod'), 'dir')
	return { root, packageRoot, baseline }
}

async function importFixtureIndex(packageRoot) {
	return import(`${pathToFileURL(path.join(packageRoot, 'lib/index.js')).href}?fixture=${Date.now()}-${Math.random()}`)
}

test('fresh rc.2 baseline gets a single-file v2 patch and route behavior is correct', async () => {
	const fixture = makeFixture()
	try {
		const first = await patchSubagentSelectedRoute({ packageRoot: fixture.packageRoot })
		assert.equal(first.changed, true)
		assert.deepEqual(first.files, [path.join(fixture.packageRoot, 'lib/index.js')])
		const indexSource = readFileSync(path.join(fixture.packageRoot, 'lib/index.js'), 'utf8')
		const invariantSource = readFileSync(path.join(fixture.packageRoot, 'lib/invariant.js'), 'utf8')
		assert.ok(indexSource.includes(MARKER))
		assert.ok(!indexSource.includes(LEGACY_MARKER))
		assert.ok(!indexSource.includes('@deepseek-ai/dsh-subagent/invariant'))
		assert.equal(invariantSource, fixture.baseline.invariant)

		const { resolveChildAgentOptions } = await importFixtureIndex(fixture.packageRoot)
		const parent = {
			options: { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 111 },
			session: { requestHeader: () => ({ config: { provider: 'ollama-local', model: 'qwen3-coder', maxTokens: 222 } }) },
		}
		assert.deepEqual(resolveChildAgentOptions(parent, undefined, 1), {
			provider: 'ollama-local', model: 'qwen3-coder', maxTokens: 222, subagentDepth: 1,
		})
		assert.deepEqual(resolveChildAgentOptions(parent, { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 333 }, 1), {
			provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 333, subagentDepth: 1,
		})
		const noHeader = { options: { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 444 }, session: { requestHeader: () => undefined } }
		assert.deepEqual(resolveChildAgentOptions(noHeader, undefined, 2), {
			provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 444, subagentDepth: 2,
		})
	} finally {
		rmSync(fixture.root, { recursive: true, force: true })
	}
})

test('migrates complete v1 and semi-old v2 states, restoring invariant byte-for-byte', async () => {
	for (const kind of ['v1', 'v2-semi']) {
		const fixture = makeFixture(kind)
		try {
			const result = await patchSubagentSelectedRoute({ packageRoot: fixture.packageRoot })
			assert.equal(result.changed, true)
			assert.equal(readFileSync(path.join(fixture.packageRoot, 'lib/invariant.js'), 'utf8'), fixture.baseline.invariant)
			assert.ok(readFileSync(path.join(fixture.packageRoot, 'lib/index.js'), 'utf8').includes(MARKER))
			assert.ok(!readFileSync(path.join(fixture.packageRoot, 'lib/index.js'), 'utf8').includes(LEGACY_MARKER))
			const second = await patchSubagentSelectedRoute({ packageRoot: fixture.packageRoot })
			assert.equal(second.changed, false)
		} finally {
			rmSync(fixture.root, { recursive: true, force: true })
		}
	}
})

test('v1 migration publishes runnable v2 index before an injected invariant-restore failure', async () => {
	const fixture = makeFixture('v1')
	try {
		let renameCount = 0
		const fsApi = {
			...fs,
			rename: async (...args) => {
				renameCount += 1
				if (renameCount === 2) throw new Error('injected invariant rename failure')
				return fs.rename(...args)
			},
		}
		await assert.rejects(() => patchSubagentSelectedRoute({ packageRoot: fixture.packageRoot, fsApi }), /injected invariant rename failure/)
		assert.ok(readFileSync(path.join(fixture.packageRoot, 'lib/index.js'), 'utf8').includes(MARKER))
		assert.ok(readFileSync(path.join(fixture.packageRoot, 'lib/invariant.js'), 'utf8').includes(LEGACY_MARKER))
		const converged = await patchSubagentSelectedRoute({ packageRoot: fixture.packageRoot })
		assert.equal(converged.changed, true)
		assert.equal(readFileSync(path.join(fixture.packageRoot, 'lib/invariant.js'), 'utf8'), fixture.baseline.invariant)
	} finally {
		rmSync(fixture.root, { recursive: true, force: true })
	}
})

test('rejects orphaned old state, unsupported versions, and unknown source text', async () => {
	const orphan = makeFixture()
	try {
		const invariantPath = path.join(orphan.packageRoot, 'lib/invariant.js')
		writeFileSync(invariantPath, readFileSync(invariantPath, 'utf8').replace(PATCH_TEXT.invariantExportOld, PATCH_TEXT.legacyInvariantExport), 'utf8')
		await assert.rejects(() => patchSubagentSelectedRoute({ packageRoot: orphan.packageRoot }), /orphaned v1 invariant/)
	} finally {
		rmSync(orphan.root, { recursive: true, force: true })
	}

	const versionFixture = makeFixture()
	try {
		const manifestPath = path.join(versionFixture.packageRoot, 'package.json')
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
		manifest.version = SUPPORTED_VERSION.replace('rc.2', 'rc.3')
		writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8')
		await assert.rejects(() => patchSubagentSelectedRoute({ packageRoot: versionFixture.packageRoot }), /supports only .*rc\.2/)
	} finally {
		rmSync(versionFixture.root, { recursive: true, force: true })
	}

	const textFixture = makeFixture()
	try {
		const indexPath = path.join(textFixture.packageRoot, 'lib/index.js')
		writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('function resolveChildAgentOptions', 'function resolveChildAgentOptionsChanged'), 'utf8')
		await assert.rejects(() => patchSubagentSelectedRoute({ packageRoot: textFixture.packageRoot }), /expected exactly one child route resolver/)
	} finally {
		rmSync(textFixture.root, { recursive: true, force: true })
	}
})

test('atomic replacement cleans its temp file when rename fails', async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'dsh-selected-route-atomic-'))
	const target = path.join(root, 'runtime.js')
	writeFileSync(target, 'old', 'utf8')
	try {
		const fsApi = { ...fs, rename: async () => { throw new Error('injected rename failure') } }
		await assert.rejects(() => atomicReplaceFile(target, 'new', { fsApi }), /injected rename failure/)
		assert.equal(readFileSync(target, 'utf8'), 'old')
		assert.deepEqual(readdirSync(root), ['runtime.js'])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

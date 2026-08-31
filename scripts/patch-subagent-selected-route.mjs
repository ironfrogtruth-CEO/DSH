#!/usr/bin/env node
/**
 * Idempotently repair generic in-process subagent route inheritance.
 *
 * A live parent may change provider/model/reasoning through the
 * agent/request waterfall without changing Agent.options. The latest
 * canonical request/header is the route's first source for each field;
 * Agent.options supplies only fields missing from that request. Explicit
 * request.agentOptions are still applied last and therefore win.
 *
 * v2 deliberately patches only @deepseek-ai/dsh-subagent/lib/index.js. The
 * in-process driver imports `resolveChildAgentOptions` from this package, so
 * both one-shot and continuable child paths share this single runtime seam.
 * v1 used a helper in lib/invariant.js; the migration below removes that old helper by
 * reversing the exact v1 replacement before installing the single-file v2.
 * Every runtime write is staged, fsynced, closed, then atomically renamed.
 */
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const SUPPORTED_VERSION = '0.1.1-rc.2'
export const MARKER = '[dsh-patch:subagent-selected-route v2]'
export const LEGACY_MARKER = '[dsh-patch:subagent-selected-route v1]'

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultPackageRoot = path.join(scriptRoot, 'install/node_modules/@deepseek-ai/dsh-subagent')

// rc.2 has appeared in two equivalent bundle import layouts. The route patch
// is self-contained and does not need either import, but both are accepted as
// baseline anchors so a package refresh cannot be mistaken for a partial patch.
const INDEX_IMPORT_OLD = 'import { isAbsolute, resolve } from "node:path";'
const INDEX_IMPORT_BUNDLED = 'import { dirname, isAbsolute, join, resolve } from "node:path";'
const INDEX_IMPORT_V1 = `${INDEX_IMPORT_OLD}\nimport { resolveSelectedRoute } from "@deepseek-ai/dsh-subagent/invariant";`

const INDEX_RESOLVER_OLD = `function resolveChildAgentOptions(parent, requested, childDepth) {
	const parentProvider = parent.options.provider;
	const parentModel = parent.options.model;
	const parentMaxTokens = parent.options.maxTokens;
	return {
		...parentProvider !== void 0 ? { provider: parentProvider } : {},
		...parentModel !== void 0 ? { model: parentModel } : {},
		...parentMaxTokens !== void 0 ? { maxTokens: parentMaxTokens } : {},
		...requested,
		subagentDepth: childDepth
	};
}`

// The v2 bundle currently installed by the previous migration. Keep this
// exact source only as a migration anchor; it is never emitted as a target
// state. This lets a package refresh converge old v2 and fresh rc.2 bundles
// to the same current route implementation.
const LEGACY_ROUTE_HELPER = `/**
* Resolve the latest valid parent request route for a generic child.
*
* A request/header snapshot is authoritative once it exists, including an
* intentionally omitted maxTokens. Agent.options is consulted only when the
* parent has not built a request header yet. This keeps a UI route switch from
* being overwritten by stale creation options while preserving the caller's
* explicit child overrides at the composition site.
* @param parent - the live delegating Agent.
* @returns provider/model/maxTokens fields suitable for AgentOptions.
*/
function resolveSelectedRoute(parent) {
	const header = parent.session?.requestHeader?.();
	const config = header?.config;
	if (config !== void 0) return {
		...config.provider !== void 0 ? { provider: config.provider } : {},
		...config.model !== void 0 ? { model: config.model } : {},
		...config.maxTokens !== void 0 ? { maxTokens: config.maxTokens } : {}
	};
	const options = parent.options ?? {};
	return {
		...options.provider !== void 0 ? { provider: options.provider } : {},
		...options.model !== void 0 ? { model: options.model } : {},
		...options.maxTokens !== void 0 ? { maxTokens: options.maxTokens } : {}
	};
}`

const LEGACY_CHILD_RESOLVER = `function resolveChildAgentOptions(parent, requested, childDepth) {
	const inherited = resolveSelectedRoute(parent);
	return {
		...inherited,
		...requested,
		subagentDepth: childDepth
	};
}`

const ROUTE_HELPER = `/**
* Resolve the latest valid parent request route for a generic child.
*
* Each route field comes from the latest request/header when present and falls
* back to the corresponding creation option only when that field is absent.
* This keeps a UI route switch from being overwritten by stale creation
* options while retaining a creation-time value for fields the request did
* not declare. The helper is shared by the bundled subagent runtime and the
* in-process driver, so one-shot and continuable children cannot diverge.
* @param parent - the live delegating Agent.
* @returns provider/model/reasoningEffort/maxTokens fields suitable for AgentOptions.
*/
function resolveSelectedRoute(parent) {
	const config = parent.session?.requestHeader?.()?.config ?? {};
	const options = parent.options ?? {};
	const route = {};
	for (const field of ["provider", "model", "reasoningEffort", "maxTokens"]) {
		const value = config[field] !== void 0 ? config[field] : options[field];
		if (value !== void 0) route[field] = value;
	}
	return route;
}`

const CHILD_RESOLVER = `function resolveChildAgentOptions(parent, requested, childDepth) {
	const inherited = resolveSelectedRoute(parent);
	const { provider, model, reasoningEffort, maxTokens, ...extra } = requested ?? {};
	return {
		...inherited,
		...extra,
		...provider !== void 0 ? { provider } : {},
		...model !== void 0 ? { model } : {},
		...reasoningEffort !== void 0 ? { reasoningEffort } : {},
		...maxTokens !== void 0 ? { maxTokens } : {},
		subagentDepth: childDepth
	};
}`

const INDEX_RESOLVER_V2 = `${ROUTE_HELPER}\n${CHILD_RESOLVER}\n\n// ${MARKER}`
const INDEX_RESOLVER_PREVIOUS_V2 = `${LEGACY_ROUTE_HELPER}\n${LEGACY_CHILD_RESOLVER}\n\n// ${MARKER}`
const INDEX_RESOLVER_V1 = `${LEGACY_CHILD_RESOLVER}\n\n// ${LEGACY_MARKER}`

const CONTINUABLE_ROUTE_OLD = 'const agentProvider = request.agentOptions?.provider ?? parent.options.provider;\n\t\tconst agentModel = request.agentOptions?.model ?? parent.options.model;'
const CONTINUABLE_ROUTE_BUNDLED = 'const inheritedRoute = resolveSelectedRoute(parent);\n\t\tconst agentProvider = request.agentOptions?.provider ?? inheritedRoute.provider;\n\t\tconst agentModel = request.agentOptions?.model ?? inheritedRoute.model;'
const CONTINUABLE_ROUTE_V1 = 'const inheritedRoute = resolveSelectedRoute(parent);\n\t\tconst agentProvider = request.agentOptions?.provider ?? inheritedRoute.provider;\n\t\tconst agentModel = request.agentOptions?.model ?? inheritedRoute.model;'
const CONTINUABLE_ROUTE_V2 = CONTINUABLE_ROUTE_V1

const INVARIANT_EXPORT_OLD = 'export { apply, inject, name };'
const LEGACY_INVARIANT_HELPER = `${LEGACY_ROUTE_HELPER}

// ${LEGACY_MARKER}`
const LEGACY_INVARIANT_EXPORT = `${LEGACY_INVARIANT_HELPER}\n${INVARIANT_EXPORT_OLD.replace('export { ', 'export { resolveSelectedRoute, ')}`

// Export exact replacement strings for fixture construction and migration
// tests. They are not part of the runtime package API.
export const PATCH_TEXT = Object.freeze({
	indexImportOld: INDEX_IMPORT_OLD,
	indexImportV1: INDEX_IMPORT_V1,
	indexResolverOld: INDEX_RESOLVER_OLD,
	indexResolverV1: INDEX_RESOLVER_V1,
	indexResolverV2: INDEX_RESOLVER_V2,
	indexResolverPreviousV2: INDEX_RESOLVER_PREVIOUS_V2,
	continuableRouteOld: CONTINUABLE_ROUTE_OLD,
	continuableRouteV1: CONTINUABLE_ROUTE_V1,
	continuableRouteV2: CONTINUABLE_ROUTE_V2,
	invariantExportOld: INVARIANT_EXPORT_OLD,
	legacyInvariantExport: LEGACY_INVARIANT_EXPORT,
})

function targetPaths(packageRoot) {
	return {
		packageJson: path.join(packageRoot, 'package.json'),
		index: path.join(packageRoot, 'lib/index.js'),
		invariant: path.join(packageRoot, 'lib/invariant.js'),
	}
}

async function readRequired(file, label) {
	try {
		return await fs.readFile(file, 'utf8')
	} catch (error) {
		throw new Error(`subagent selected-route patch ${label} is unavailable: ${file} (${error.code ?? error.message})`)
	}
}

function countOccurrences(source, text) {
	return source.split(text).length - 1
}

function replaceExactly(source, oldText, newText, label) {
	const count = countOccurrences(source, oldText)
	if (count !== 1) throw new Error(`subagent selected-route patch expected exactly one ${label}, found ${count}`)
	return source.replace(oldText, newText)
}

/**
 * Replace one runtime file through a same-directory temporary file. The
 * optional fsApi is intentionally injectable for the rename-failure test.
 */
export async function atomicReplaceFile(file, content, { fsApi = fs } = {}) {
	const temporary = `${file}.tmp-subagent-selected-route-${process.pid}-${randomUUID()}`
	let handle
	try {
		handle = await fsApi.open(temporary, 'wx', 0o644)
		await handle.writeFile(content, 'utf8')
		await handle.sync()
		await handle.close()
		handle = undefined
		await fsApi.rename(temporary, file)
	} catch (error) {
		try {
			await handle?.close()
		} catch {}
		try {
			await fsApi.unlink(temporary)
		} catch {}
		throw error
	}
}

function assertVersion(manifestText) {
	let manifest
	try {
		manifest = JSON.parse(manifestText)
	} catch (error) {
		throw new Error(`subagent selected-route patch package manifest is not valid JSON: ${error.message}`)
	}
	if (manifest.version !== SUPPORTED_VERSION) throw new Error(`subagent selected-route patch supports only @deepseek-ai/dsh-subagent ${SUPPORTED_VERSION}, found ${String(manifest.version)}`)
}

function assertSingleBaselineAnchor(source, text, label) {
	if (countOccurrences(source, text) !== 1) throw new Error(`subagent selected-route patch expected exactly one ${label}`)
}

function validateV1(indexSource, invariantSource) {
	if (!indexSource.includes(INDEX_RESOLVER_V1) || !indexSource.includes(CONTINUABLE_ROUTE_V1) && !indexSource.includes(CONTINUABLE_ROUTE_OLD)) throw new Error('subagent selected-route patch found a malformed v1 index; refusing to guess')
	if (!invariantSource.includes(LEGACY_INVARIANT_EXPORT) || countOccurrences(invariantSource, LEGACY_INVARIANT_EXPORT) !== 1) throw new Error('subagent selected-route patch found a malformed v1 invariant; refusing to guess')
}

function validateV2(indexSource, invariantSource) {
	const current = indexSource.includes(INDEX_RESOLVER_V2)
	const previous = indexSource.includes(INDEX_RESOLVER_PREVIOUS_V2)
	if (current === previous || indexSource.includes(INDEX_IMPORT_V1) || indexSource.includes(LEGACY_MARKER)) throw new Error('subagent selected-route patch found a malformed v2 index; refusing to guess')
	if (current && !indexSource.includes(CONTINUABLE_ROUTE_V2) && !indexSource.includes(CONTINUABLE_ROUTE_OLD)) throw new Error('subagent selected-route patch found a malformed v2 index; refusing to guess')
	if (previous && !indexSource.includes(CONTINUABLE_ROUTE_V1) && !indexSource.includes(CONTINUABLE_ROUTE_OLD)) throw new Error('subagent selected-route patch found a malformed previous v2 index; refusing to guess')
	const legacyInvariant = invariantSource.includes(LEGACY_MARKER)
	if (invariantSource.includes(MARKER) || legacyInvariant && (!invariantSource.includes(LEGACY_INVARIANT_EXPORT) || countOccurrences(invariantSource, LEGACY_INVARIANT_EXPORT) !== 1) || !legacyInvariant && countOccurrences(invariantSource, INVARIANT_EXPORT_OLD) !== 1) throw new Error('subagent selected-route patch found a malformed v2 invariant; refusing to guess')
	return { current, previous }
}

function validateBaseline(indexSource, invariantSource) {
	if (indexSource.includes(MARKER) || indexSource.includes(LEGACY_MARKER) || invariantSource.includes(MARKER) || invariantSource.includes(LEGACY_MARKER)) throw new Error('subagent selected-route patch found an unsupported partial state; refusing to guess')
	const importAnchors = [INDEX_IMPORT_OLD, INDEX_IMPORT_BUNDLED].filter((anchor) => indexSource.includes(anchor))
	if (importAnchors.length !== 1 || countOccurrences(indexSource, importAnchors[0]) !== 1) throw new Error('subagent selected-route patch expected exactly one index import anchor')
	assertSingleBaselineAnchor(indexSource, INDEX_RESOLVER_OLD, 'child route resolver')
	const continuationAnchors = [CONTINUABLE_ROUTE_OLD, CONTINUABLE_ROUTE_BUNDLED].filter((anchor) => indexSource.includes(anchor))
	if (continuationAnchors.length !== 1 || countOccurrences(indexSource, continuationAnchors[0]) !== 1) throw new Error('subagent selected-route patch expected exactly one continuable route resolver')
	assertSingleBaselineAnchor(invariantSource, INVARIANT_EXPORT_OLD, 'invariant export anchor')
}

export async function patchSubagentSelectedRoute({ packageRoot = defaultPackageRoot, fsApi = fs } = {}) {
	const normalizedRoot = path.resolve(packageRoot)
	const targets = targetPaths(normalizedRoot)
	assertVersion(await readRequired(targets.packageJson, 'package manifest'))
	let indexSource = await readRequired(targets.index, 'index runtime')
	let invariantSource = await readRequired(targets.invariant, 'invariant runtime')

	const indexV2 = indexSource.includes(MARKER)
	const indexV1 = indexSource.includes(LEGACY_MARKER)
	const invariantV1 = invariantSource.includes(LEGACY_MARKER)
	if (indexV2 && indexV1) throw new Error('subagent selected-route patch found both v1 and v2 markers in index; refusing to guess')
	if (invariantV1 && !indexV1 && !indexV2) throw new Error('subagent selected-route patch found an orphaned v1 invariant; refusing to guess')
	if (indexV1) validateV1(indexSource, invariantSource)
	const v2Shape = indexV2 ? validateV2(indexSource, invariantSource) : undefined
	if (!indexV1 && !indexV2) validateBaseline(indexSource, invariantSource)

	let changed = false
	if (indexV2) {
		if (v2Shape.previous) {
			indexSource = replaceExactly(indexSource, INDEX_RESOLVER_PREVIOUS_V2, INDEX_RESOLVER_V2, 'previous v2 route migration')
			await atomicReplaceFile(targets.index, indexSource, { fsApi })
			changed = true
		}
		if (invariantV1) {
			const restored = replaceExactly(invariantSource, LEGACY_INVARIANT_EXPORT, INVARIANT_EXPORT_OLD, 'legacy invariant restoration')
			await atomicReplaceFile(targets.invariant, restored, { fsApi })
			changed = true
		}
	} else {
		let nextIndex
		if (indexV1) {
			nextIndex = indexSource.includes(INDEX_IMPORT_V1)
				? replaceExactly(indexSource, INDEX_IMPORT_V1, INDEX_IMPORT_OLD, 'legacy index import removal')
				: indexSource
			nextIndex = replaceExactly(nextIndex, INDEX_RESOLVER_V1, INDEX_RESOLVER_V2, 'legacy child route migration')
			if (nextIndex.includes(CONTINUABLE_ROUTE_OLD)) nextIndex = replaceExactly(nextIndex, CONTINUABLE_ROUTE_OLD, CONTINUABLE_ROUTE_V2, 'legacy continuable route migration')
		} else {
			nextIndex = replaceExactly(indexSource, INDEX_RESOLVER_OLD, INDEX_RESOLVER_V2, 'child route resolver')
			if (nextIndex.includes(CONTINUABLE_ROUTE_OLD)) nextIndex = replaceExactly(nextIndex, CONTINUABLE_ROUTE_OLD, CONTINUABLE_ROUTE_V2, 'continuable route resolver')
		}
		// Publish the self-contained index first. If the legacy invariant restore
		// is interrupted, the v2 index remains runnable and the next invocation
		// can safely converge the harmless leftover invariant.
		await atomicReplaceFile(targets.index, nextIndex, { fsApi })
		if (invariantV1) {
			const restored = replaceExactly(invariantSource, LEGACY_INVARIANT_EXPORT, INVARIANT_EXPORT_OLD, 'legacy invariant restoration')
			await atomicReplaceFile(targets.invariant, restored, { fsApi })
		}
		changed = true
	}

	return {
		changed,
		packageRoot: normalizedRoot,
		files: [targets.index],
		...invariantV1 ? { restoredLegacyInvariant: true } : {},
	}
}

function parseArgs(argv) {
	const args = { packageRoot: defaultPackageRoot }
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index]
		if (token === '--package-root') args.packageRoot = argv[++index]
		else if (token === '--help' || token === '-h') args.help = true
		else throw new Error(`unknown option ${token}`)
	}
	return args
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		const args = parseArgs(process.argv.slice(2))
		if (args.help) process.stdout.write('Usage: patch-subagent-selected-route.mjs [--package-root PACKAGE_ROOT]\n')
		else {
			const result = await patchSubagentSelectedRoute(args)
			process.stdout.write(`${result.changed ? '[patch] 已应用' : '[patch] 已打过补丁,跳过'}: subagent selected route (${result.files.join(', ')})${result.restoredLegacyInvariant ? ' + invariant v1 restored' : ''}\n`)
		}
	} catch (error) {
		process.stderr.write(`[patch] 失败: ${error.stack || error}\n`)
		process.exitCode = 1
	}
}

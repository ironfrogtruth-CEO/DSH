/**
 * Host-only opt-in package.  The default export is the rc.8-compatible
 * CompactionEngine subclass; no client half or UI hook is shipped.
 */
import DshCompactionV2Engine, { BasicCompactionEngine } from './engine.js'

export const name = 'dsh-compaction-v2'
export const inject = DshCompactionV2Engine.inject
export { BasicCompactionEngine, DshCompactionV2Engine }
export { default } from './engine.js'
export * from './extractor.js'
export * from './capsule-store.js'

#!/usr/bin/env node
/** Replay the rc.2 generic ToolRow fix that honors Host presentCall titles. */
import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

export const BASELINE_VERSION = '0.1.1-rc.2'
export const MARKER = '[local-mod] Generic Host tools already carry a replay-safe title'
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const ORIGINAL = `\t\t\tconst toolTitle = TOOL_TITLES[toolName];
\t\t\tconst summary = variant === "others" && toolName !== "" && toolTitle === void 0 ? \`\${toolName} · \${base}\` : base;`

export const MODIFIED = `\t\t\tconst toolTitle = TOOL_TITLES[toolName];
\t\t\t// ${MARKER} from
\t\t\t// presentCall(). Prefer it over the static "Tool call + wire name" label.
\t\t\tconst presentedTitle = block.callView?.card === "generic" && typeof block.callView.title === "string" && block.callView.title.trim() !== "" ? block.callView.title.trim() : void 0;
\t\t\tconst summary = presentedTitle !== void 0 ? "" : variant === "others" && toolName !== "" && toolTitle === void 0 ? \`\${toolName} · \${base}\` : base;`

export const ORIGINAL_TITLE = `\t\t\t\ttitle: toolTitle ?? VARIANT_TITLES[variant],`
export const MODIFIED_TITLE = `\t\t\t\ttitle: presentedTitle ?? toolTitle ?? VARIANT_TITLES[variant],`

function occurrenceCount(text, needle) {
  return text.split(needle).length - 1
}

export function patchToolCallPresentationTitles(source) {
  if (source.includes(MARKER)) {
    if (!source.includes(MODIFIED_TITLE)) throw new Error('TOOL_TITLE_PATCH_INCOMPLETE: marker exists without title selection')
    return { changed: false, text: source }
  }
  if (occurrenceCount(source, ORIGINAL) !== 1 || occurrenceCount(source, ORIGINAL_TITLE) !== 1) {
    throw new Error('TOOL_TITLE_PATCH_DRIFT: expected rc.2 ToolRow anchors exactly once')
  }
  return {
    changed: true,
    text: source.replace(ORIGINAL, MODIFIED).replace(ORIGINAL_TITLE, MODIFIED_TITLE),
  }
}

async function atomicWrite(path, text) {
  const temporary = `${path}.tmp-tool-title-${process.pid}-${randomUUID()}`
  const mode = (await stat(path)).mode & 0o777
  try {
    await writeFile(temporary, text, { mode: mode || 0o644 })
    await rename(temporary, path)
  } catch (error) {
    try { await unlink(temporary) } catch {}
    throw error
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const root = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : scriptRoot
  const packageRoot = join(root, 'install/node_modules/@deepseek-ai/dsh-client-ui-tool')
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (String(manifest.version || '') !== BASELINE_VERSION) {
    throw new Error(`TOOL_TITLE_PATCH_VERSION_MISMATCH: expected ${BASELINE_VERSION}, got ${manifest.version || '<missing>'}`)
  }
  const target = join(packageRoot, 'lib/client.js')
  const result = patchToolCallPresentationTitles(await readFile(target, 'utf8'))
  if (result.changed && apply) await atomicWrite(target, result.text)
  const ok = !result.changed || apply
  console.log(JSON.stringify({ ok, changed: result.changed && apply, status: result.changed ? apply ? 'applied' : 'needs_apply' : 'clean', target }))
  if (!ok) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(String(error?.message || error))
    process.exitCode = 1
  })
}

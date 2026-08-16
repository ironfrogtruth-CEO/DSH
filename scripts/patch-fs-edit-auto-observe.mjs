#!/usr/bin/env node
/**
 * 幂等补丁:edit 工具自动先观察目标 — 消除 FS_NOT_OBSERVED 报错
 *
 * 背景:fs-observation-policy 要求"先读后写",edit 目标未在本会话被 read 过时,
 * 在 fs/edit-intent 瀑布处抛 FS_NOT_OBSERVED("edit requires reading ... first")。
 * 模型经常在子代理/新线程/换会话后直接 edit,反复吃到该错误。
 *
 * 本补丁让 edit 工具在执行前自动 stat 目标并广播 fs/observed(与 read 工具同款事件),
 * 从 harness 层面消除这类错误:
 *   - 仅 stat 不读全文,开销可忽略;
 *   - 观察版本同时作为 editText 的 CAS 基准,并发修改会安全失败;
 *   - 文件不存在 → 观察"absent" → 策略给出明确的 FS_NOT_FOUND;
 *   - stat 失败 → 保持原行为(交给策略判定);
 *   - 同时更新 tool:edit 的系统提示,移除"必须先读"的措辞。
 *
 * 幂等:含标记的文件直接跳过;install 升级后重跑即可(ensure-web 已接线)。
 * 用法:node ~/.dsh/scripts/patch-fs-edit-auto-observe.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const MARKER = '[dsh-patch:edit-auto-observe v1]'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'install/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js')

const EXEC_OLD = `		async execute(args, exec) {
			const input = parseEditArgs(args);
			const sandboxPolicy = await sandbox.resolvePolicy("edit", args, exec);
			const target = await ctx.fs.resolve(input.filePath, sessionResolveOptions(exec, input.filePath, sandboxPolicy?.workspaceRoot));
			let outcome;
			try {
				const intent = await ctx.waterfall("fs/edit-intent", target, exec, () => void 0);`

const EXEC_NEW = `		async execute(args, exec) {
			const input = parseEditArgs(args);
			const sandboxPolicy = await sandbox.resolvePolicy("edit", args, exec);
			const target = await ctx.fs.resolve(input.filePath, sessionResolveOptions(exec, input.filePath, sandboxPolicy?.workspaceRoot));
			// ${MARKER} 编辑前自动观察(stat)目标并广播 fs/observed,满足
			// fs-observation-policy 的"先读后写"要求 —— 模型无需先手动 read 也不会
			// 吃到 FS_NOT_OBSERVED。仅 stat 不读全文;观察版本同时作为 editText 的
			// CAS 基准,并发修改会安全失败。stat 失败则保持原行为(交给策略判定)。
			try {
				const info = await ctx.fs.stat(target, exec.signal);
				ctx.emit("fs/observed", target, info === void 0 ? { kind: "absent" } : { kind: "present", version: info.version }, exec);
			} catch {}
			let outcome;
			try {
				const intent = await ctx.waterfall("fs/edit-intent", target, exec, () => void 0);`

const PROMPT_OLD = 'Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.'
const PROMPT_NEW = 'The tool auto-observes the target, so no prior read is required; still read the file first when you need its content to craft an exact old_string.'

let src
try {
  src = await readFile(file, 'utf8')
} catch (err) {
  console.error(`[patch] 跳过(文件不存在): ${file} (${err.code})`)
  process.exit(1)
}

if (src.includes(MARKER)) {
  console.log('[patch] 已打过补丁,跳过: dsh-tool-fs: edit 自动观察')
  process.exit(0)
}

const missing = []
if (!src.includes(EXEC_OLD)) missing.push('execute 自动观察块')
if (!src.includes(PROMPT_OLD)) missing.push('tool:edit 提示文案')
if (missing.length > 0) {
  console.error(`[patch] 警告:未找到待替换原文(${missing.join('、')}),请人工核对: ${file}`)
  process.exit(1)
}

await writeFile(file, src.replace(EXEC_OLD, EXEC_NEW).replace(PROMPT_OLD, PROMPT_NEW), 'utf8')
console.log('[patch] 已应用: dsh-tool-fs: edit 自动观察 + 提示文案更新')

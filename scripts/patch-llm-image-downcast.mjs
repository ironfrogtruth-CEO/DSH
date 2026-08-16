#!/usr/bin/env node
/**
 * 幂等补丁:DeepSeek / pi-ai LLM 适配器 — 历史中的图片块降级为文字占位
 *
 * 背景:当前官方线路是纯文本模型(deepseek-v4-flash)。任何 image block
 * (浏览器截图附件、read_image、用户粘贴图片)进入会话历史后,适配器序列化
 * 整段历史时抛 UNSUPPORTED_CONTENT;且该 block 永久留在历史里,导致之后
 * 每一轮(即使纯文字)都失败 —— 线程报废,无法继续对话。
 *
 * 本补丁把两处硬抛错改为「降级为文字占位」(在序列化前原地改写):
 *   - dsh-llm-deepseek 的 assertTextOnly()
 *   - dsh-llm-pi-ai 的 textOnlyContext()
 * 设置环境变量 DSH_LLM_STRICT_IMAGES=1 可恢复旧的硬拒绝行为(视觉模型部署)。
 *
 * 幂等:已含标记的文件直接跳过;install 升级后重跑即可(ensure-web 已接线)。
 * 用法:node ~/.dsh/scripts/patch-llm-image-downcast.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const MARKER = '[dsh-patch:image-downcast v1]'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const DOWNCAST_BODY = `if (!contentHasImage(blocks)) return;
	if (process.env.DSH_LLM_STRICT_IMAGES === "1") throw new LlmError("The DeepSeek chat-completions adapter does not support image content.", "UNSUPPORTED_CONTENT");
	// ${MARKER} 历史中的图片块降级为文字占位(否则该 block 永久留在历史里,
	// 之后每一轮序列化都抛 UNSUPPORTED_CONTENT,线程报废)。视觉模型部署设
	// DSH_LLM_STRICT_IMAGES=1 恢复硬拒绝。
	for (const block of blocks) {
		if (block.type === "image") {
			const id = block.attachment?.attachmentId ?? "unknown";
			block.type = "text";
			block.text = "[图片已跳过: 当前 DeepSeek 模型不支持图像输入 (attachment: " + id + ")]";
			delete block.attachment;
		} else if (block.type === "tool-result" && Array.isArray(block.content)) {
			for (const inner of block.content) {
				if (inner.type === "image") {
					const id2 = inner.attachment?.attachmentId ?? "unknown";
					inner.type = "text";
					inner.text = "[截图/图片已跳过: 当前模型不支持图像输入 (attachment: " + id2 + ")]";
					delete inner.attachment;
				}
			}
		}
	}`

const targets = [
  {
    file: 'install/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js',
    old: `function assertTextOnly(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("The DeepSeek chat-completions adapter does not support image content.", "UNSUPPORTED_CONTENT");
}`,
    name: 'dsh-llm-deepseek: assertTextOnly',
  },
  {
    file: 'install/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
    old: `if (contentHasImage(message.content)) throw new LlmError("pi-ai image conversion requires the durable attachment service", "UNSUPPORTED_CONTENT");`,
    name: 'dsh-llm-pi-ai: textOnlyContext',
  },
]

const piBody = `if (contentHasImage(message.content)) {
			if (process.env.DSH_LLM_STRICT_IMAGES === "1") throw new LlmError("pi-ai image conversion requires the durable attachment service", "UNSUPPORTED_CONTENT");
			// ${MARKER} 无附件服务的纯文本路径:图片块降级为文字占位,避免历史残留导致线程报废。
			for (const block of message.content) {
				if (block.type === "image") {
					const id = block.attachment?.attachmentId ?? "unknown";
					block.type = "text";
					block.text = "[图片已跳过: 当前模型不支持图像输入 (attachment: " + id + ")]";
					delete block.attachment;
				} else if (block.type === "tool-result" && Array.isArray(block.content)) {
					for (const inner of block.content) {
						if (inner.type === "image") {
							const id2 = inner.attachment?.attachmentId ?? "unknown";
							inner.type = "text";
							inner.text = "[截图/图片已跳过: 当前模型不支持图像输入 (attachment: " + id2 + ")]";
							delete inner.attachment;
						}
					}
				}
			}
		}`

const replacements = [
  { ...targets[0], new: `function assertTextOnly(blocks) {\n\t${DOWNCAST_BODY}\n}` },
  { ...targets[1], new: piBody },
]

let changed = 0
for (const { file, old, new: next, name } of replacements) {
  const full = path.join(root, file)
  let src
  try {
    src = await readFile(full, 'utf8')
  } catch (err) {
    console.error(`[patch] 跳过(文件不存在): ${file} (${err.code})`)
    continue
  }
  if (src.includes(MARKER)) {
    console.log(`[patch] 已打过补丁,跳过: ${name}`)
    continue
  }
  if (!src.includes(old)) {
    console.error(`[patch] 警告:未找到待替换原文,请人工核对: ${name}`)
    process.exitCode = 1
    continue
  }
  await writeFile(full, src.replace(old, next), 'utf8')
  changed += 1
  console.log(`[patch] 已应用: ${name}`)
}
console.log(changed > 0 ? `[patch] 完成,共应用 ${changed} 处。` : '[patch] 无新增改动。')

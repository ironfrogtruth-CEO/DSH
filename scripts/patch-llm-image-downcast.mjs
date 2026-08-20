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
 * 仅适用于 rc.7 及更早版本。rc.8 起官方适配器已按模型能力
 * 区分文本和原生图片路径，继续改写 bundle 反而会破坏原生多模态。
 * 幂等:已含标记的文件直接跳过;install 升级后重跑即可(ensure-web 已接线)。
 * 用法:node ~/.dsh/scripts/patch-llm-image-downcast.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const MARKER = '[dsh-patch:image-downcast v2]'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// rc.8 起，DeepSeek 与 pi-ai 适配器已原生处理图片能力声明、
// 持久附件与请求体上限。旧补丁只能服务于 rc.7 及更早版本。
const dshPackage = path.join(root, 'install/node_modules/@deepseek-ai/dsh/package.json')
try {
	const installed = JSON.parse(await readFile(dshPackage, 'utf8'))
	const match = /^0\.1\.0-rc\.(\d+)$/.exec(String(installed.version || ''))
	if (!match || Number(match[1]) >= 8) {
		console.log(`[patch] 跳过: DSH ${installed.version} 已原生支持按模型能力处理图片`)
		process.exit(0)
	}
} catch (error) {
	console.error(`[patch] 警告:无法读取 DSH 版本，按旧版兼容补丁继续: ${error.message}`)
}

const DOWNCAST_BODY = `if (!contentHasImage(blocks)) return;
	if (process.env.DSH_LLM_STRICT_IMAGES === "1") throw new LlmError("The DeepSeek chat-completions adapter does not support image content.", "UNSUPPORTED_CONTENT");
	// ${MARKER} 会话消息可能是冻结对象,不做原地改写。
	// flattenText() 在序列化阶段生成文字占位。`

const DEEPSEEK_FLATTEN_OLD = `function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}`
const DEEPSEEK_FLATTEN_NEW = `function flattenText(blocks) {
	return blocks.map((block) => block.type === "text" ? block.text : block.type === "image" ? \`[图片已转为文字识别结果；原始附件未发送给当前 DeepSeek 文本模型: \${block.attachment?.attachmentId ?? "unknown"}]\` : "").join("");
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
			// ${MARKER} 只读消息不做原地改写；flattenText/toolResultText 生成文字占位。
		}`

const PI_FLATTEN_OLD = `function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Flatten text recursively inside one tool result. */
function toolResultText(blocks) {
	return blocks.map((block) => block.type === "text" ? block.text : block.type === "tool-result" ? toolResultText(block.content) : "").join("");
}`
const PI_FLATTEN_NEW = `function flattenText(message) {
	return message.content.map((block) => block.type === "text" ? block.text : block.type === "image" ? \`[图片已转为文字识别结果；原始附件未发送给当前文本模型: \${block.attachment?.attachmentId ?? "unknown"}]\` : "").join("");
}
/** Flatten text recursively inside one tool result. */
function toolResultText(blocks) {
	return blocks.map((block) => block.type === "text" ? block.text : block.type === "image" ? \`[图片已转为文字识别结果；原始附件未发送给当前文本模型: \${block.attachment?.attachmentId ?? "unknown"}]\` : block.type === "tool-result" ? toolResultText(block.content) : "").join("");
}`

const replacements = [
  { file: targets[0].file, old: DEEPSEEK_FLATTEN_OLD, new: DEEPSEEK_FLATTEN_NEW, name: 'dsh-llm-deepseek: flattenText' },
  { ...targets[0], new: `function assertTextOnly(blocks) {\n\t${DOWNCAST_BODY}\n}` },
  { file: targets[1].file, old: PI_FLATTEN_OLD, new: PI_FLATTEN_NEW, name: 'dsh-llm-pi-ai: flattenText' },
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
  const guardAlreadyPatched = (name.includes('assertTextOnly') || name.includes('textOnlyContext')) && src.includes(MARKER)
  if (src.includes(next) || guardAlreadyPatched) {
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

---
name: image-media-handling
description: 识图与生图工具的调用纪律：OCR、图表解析、视觉问答、AI 生图默认走智谱免费 MCP，不可用才降级本地；识别结果要精简输出，防止图片内容撑爆上下文。
---

# 图片与媒体处理策略

## 工具优先级（默认 MCP，降级本地）

**识图**（视觉问答 / OCR / 图表解析）：
1. `mcp__zhipu__vision_read` / `mcp__zhipu__ocr_image` / `mcp__zhipu__analyze_chart`（智谱 GLM-4.6V-Flash 等免费视觉模型，国内直连）
2. 降级链：MCP 调用报错（网络失败、超时、工具缺失）时 → 本地 `screen_ocr`（本地 OCR）→ 主模型自带视觉。
3. MCP 服务器内置三模型自动回退（glm-4.6v-flash → glm-4v-flash → glm-4.1v-thinking-flash），单次限流由它处理；仍失败才降级本地。

**生图**：
1. `mcp__zhipu__generate_image`（CogView-3-Flash，免费）
2. 降级：本地 ollama `x/flux2-klein:4b`（`curl http://127.0.0.1:11434/api/generate`）。

**视频**：`mcp__zhipu__generate_video`（CogVideoX-Flash，免费，5/10 秒）。

## 上下文纪律（防止图片信息撑爆上下文）

- 图片识别结果：**只保留要点摘要（单图不超过 240 字）放回对话**；完整识别文本写入 `~/.dsh/vision-results/`，回复中给出文件路径。
- **绝不**把图片 base64 / data URI / 大段识别原文贴回对话。
- 一张图只总结一次；多图合并要点，不逐张复制原文。
- 生图：只返回保存路径与一句话说明，不贴长 URL。

## 图片交付

- 生图默认保存到 `~/.dsh/zhipu-images/`；聊天界面（zhipu-media 插件）在折叠工具组外直接显示缩略图，点击可放大预览（Lightbox）。
- 用户贴图：识别后给出结构化要点；长识别结果落盘供后续引用。

## 界面备忘

- 官方拖拽蒙版由 zhipu-media 插件在插入时立即移除；贴图反馈由输入框上方的无蒙版草稿条承担。
- 工具调用卡片默认折叠；展开后仍走官方 `tool.call.toolview`，Bash、Read、生图等详情不会丢失。Think 使用官方折叠行。

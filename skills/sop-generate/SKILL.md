---
name: sop-generate
description: SOP 流水线的生成节点：依据已确认的结构，选择注册的技能、工具与模型别名产出产物，输出全程可追溯、可回滚。
---

# SOP Generate Node

Use this as node `generate`.

## Work

Generate artifacts only from confirmed upstream contracts:

- Markdown text
- HTML
- PPT/PPTX
- PDF
- PNG/JPG
- CSV/JSON
- OCR/transcription outputs
- image or audio assets

## Selection Rules

- Select skills from `sop-orchestrator/references/skill_registry.json`.
- Select tools from `tool_registry.json`.
- Select models from `model_registry.json`.
- If a model/tool is `needs_runtime_check`, say so and provide a fallback.
- Do not claim unavailable future models or tools are active.

## QA Gate

Block if:

- Generation ignores confirmed structure.
- Output lacks source refs where required.
- Tool/model availability is misrepresented.
- Generated artifact cannot be validated.

## Stop Policy

Stop before generation if style, source sufficiency, banned wording, or scope remains unconfirmed.

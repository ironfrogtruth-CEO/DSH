---
name: sop-export
description: SOP 流水线的导出节点：把已验收产物打包成 Markdown、HTML、PDF、PPTX、PNG、CSV、JSON 或可移植技能包，记录路径并拦下未验证输出。
---

# SOP Export Node

Use this as node `export`.

## Work

Export only after validation passes. Record:

- artifact type
- absolute local path when available
- source contract used
- validation status
- known limitations
- portability notes

## Supported Deliverables

- Markdown
- HTML
- PDF
- PPTX
- PNG/JPG
- CSV/JSON
- ZIP packages
- skill folders

## QA Gate

Block if:

- Validation did not pass.
- Export contains editor chrome or debug controls.
- Paths are missing for local files.
- Format does not match user request.
- Export shifted layout or lost editability when those were requirements.

## Stop Policy

Stop after export with concise delivery paths and local QA status.

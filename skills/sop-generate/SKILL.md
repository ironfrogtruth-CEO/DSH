---
name: sop-generate
description: Use this skill as the generate node in a harness SOP pipeline to create artifacts from a confirmed structure by selecting registered skills, tools, and model aliases while keeping outputs traceable and rollback-safe.
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

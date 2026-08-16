---
name: sop-orchestrator
description: Use this skill for complex, multi-step, multi-artifact tasks that need harness-style routing, 总控编排, source-truth separation, node-by-node status, confirmation gates, QA blocking, rollback points, and portable skill/tool/model registries. Prefer goal-first-control（以终为始）as the user-facing entrypoint when available.
---

# SOP Orchestrator

Use this skill when the task is too complex for a one-shot answer: multiple stages, multiple artifacts, source-truth risk, rendering/export needs, user confirmation points, restart-from-node, or rollback requirements.

## Core Rule

Treat complex work as a production line:

`route -> parse -> structure -> generate -> validate -> export -> review`

Simple tasks should be answered directly after a lightweight route check. Do not force the full SOP onto trivial requests.

## Status Line

Show pipeline progress for complex tasks:

`[路由｜🔄进行中] -> [解析｜⚪未开始] -> [结构化｜⚪未开始] -> [生成｜⚪未开始] -> [验证｜⚪未开始] -> [导出｜⚪未开始] -> [复盘｜⚪未开始]`

Allowed status values:

- `✅完成`
- `🔄进行中`
- `⏸待确认`
- `⛔阻断`
- `↩回滚`
- `⚪未开始`

## Source Classes

Keep these classes separate:

- **truth_sources**: user originals, screenshots, files, explicit user statements, authoritative data.
- **derived_outputs**: tables, copy, plans, drafts, generated files.
- **debug_notes**: temporary assumptions and process observations.
- **pollution_risks**: stale templates, wrong terminology, outdated material, unsupported claims.

Never present derived output as a truth source. If source truth is weak, mark it `待确认` or `需补证`.

## Node Contract

Every SOP node should maintain:

```json
{
  "node_id": "",
  "status": "",
  "goal": "",
  "inputs": [],
  "truth_sources": [],
  "derived_outputs": [],
  "debug_notes": [],
  "pollution_risks": [],
  "skill_used": "",
  "tool_candidates": [],
  "model_candidates": [],
  "artifacts": [],
  "qa_gate": {"status": "", "checks": []},
  "stop_policy": "",
  "rollback_to": ""
}
```

## Registries

Load registry files only when needed:

- `references/node_registry.json`: canonical seven-node pipeline and node contracts.
- `references/skill_registry.json`: local and portable skill mappings.
- `references/tool_registry.json`: tool candidates and availability.
- `references/model_registry.json`: model aliases and runtime availability.
- `references/failure_taxonomy.json`: blocking failure categories.
- `references/workflow_profiles.json`: default and artifact-specific workflow profiles.
- `references/artifact_contract_registry.json`: expected intermediate/final artifacts by output type.
- `references/runtime_contract_schema.json`: extended node contract fields for execution, model, QA, rollback, and artifact policy.
- `references/render_contract_policy.md`: registry-backed visual/render selection rules.

Use registry IDs in plans and QA reports. Do not hide selections inside generation logic. For render workflows, preserve framework/template/component/asset IDs in intermediate contracts and final artifacts when possible.

## Confirmation Gates

Stop for user confirmation when a completed node materially changes downstream work:

- Route confirms the task should enter SOP.
- Structure confirms outline, schema, page plan, field design, or core logic.
- Pre-generation confirms style, scope, priority, banned wording, and source sufficiency.
- Validation failure blocks export and routes back to the failing node.

If the user explicitly says "continue", proceed from the current node without repeating confirmed upstream content.

## Rollback

When the user requests rollback:

1. Keep confirmed upstream nodes.
2. Mark the requested node as `↩回滚`.
3. Redo only that node and affected downstream nodes.
4. Preserve source-truth mappings unless the rollback changes source selection.

## Progress and Artifacts

For every complex node, report:

- node status
- selected skill/tool/model candidates
- produced artifact names or paths
- QA gate result
- next node or rollback target

If no file artifact is produced, name the process artifact, such as `source_map`, `structure_contract`, `visual_contract`, or `qa_report`.

## Output Discipline

- Text artifacts default to Markdown.
- Use fenced code blocks for drafts, SOPs, specs, PRDs, and field definitions when delivering copy.
- For render/export tasks, include output paths and QA status.
- For local checks, report them as local checks only; do not claim user acceptance.

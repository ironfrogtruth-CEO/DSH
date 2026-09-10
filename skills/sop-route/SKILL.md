---
name: sop-route
description: SOP 流水线的路由节点：判断请求是简单直答还是复杂 SOP 工作，并识别目标、输入是否充分、真源、约束、风险、验证方式与回滚点。
---

# SOP Route Node

Use this as node `route`.

## Decision

Classify the request:

- `simple_direct`: one-step answer, no durable artifact, low fact/render risk.
- `sop_required`: multi-step, multi-artifact, source-truth risk, rendering/export, user confirmation, rollback, or tool orchestration.

## Required Output

Emit a node contract with:

- `goal`
- `input_sufficiency`: `sufficient`, `partial`, or `blocked`
- `truth_sources`
- `constraints`
- `risks`
- `validation_method`
- `rollback_points`
- `recommended_pipeline`

## QA Gate

Block if:

- Goal is unclear.
- Required input is absent and cannot be discovered.
- Truth sources are confused with derived outputs.
- The task needs SOP but is being treated as a one-shot answer.

## Stop Policy

If `sop_required` and the user has not already approved execution, stop after route confirmation.

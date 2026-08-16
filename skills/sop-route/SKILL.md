---
name: sop-route
description: Use this skill as the route node in a harness SOP pipeline to decide whether a request is simple direct-answer work or complex SOP work, and to identify goal, input sufficiency, truth sources, constraints, risks, validation method, and rollback points.
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

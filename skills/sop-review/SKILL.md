---
name: sop-review
description: SOP 流水线的评审节点：交付后汇总完成的节点、产物、QA 结果、失败与回滚，沉淀可复用模式与后续改进项。
---

# SOP Review Node

Use this as node `review`.

## Work

After export or a blocked run, produce a concise retrospective:

- pipeline states
- artifacts created
- QA results
- failures and rollback points
- unresolved evidence gaps
- reusable skills/tools/model selections
- recommended next improvements

## QA Gate

Block if:

- Review overstates validation.
- Local checks are described as user acceptance.
- Remaining risks are hidden.
- Reusable pattern lacks a concrete future trigger.

## Stop Policy

End with current state and next action. Do not restart upstream nodes unless the user asks.

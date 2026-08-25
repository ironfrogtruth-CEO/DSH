---
name: goal-first-control
description: 以终为始 / goal-first-control：Use as the default entrypoint for complex work. Start from the required outcome and success criteria, work backward through validation, artifacts, structure, and truth sources, then route to the right skills, tools, models, QA gates, and rollback points. Do not force the full pipeline onto simple one-step requests.
---

# 以终为始

Use this controller before specialized skills when a request has multiple meaningful steps, durable artifacts, source-truth risk, rendering/export, external side effects, or a need for rollback.

## First-principles goal contract

Before choosing a workflow, answer these questions from the user's request and discoverable facts:

1. What problem must be solved, not merely what activity was requested?
2. Who will use the result, and what decision or action should it enable?
3. What exact deliverable or observable state is required?
4. Which facts are authoritative, and which inputs are assumptions, stale templates, derived outputs, or debug notes?
5. Which constraints and user-owned choices cannot be crossed?
6. What evidence would prove completion?
7. What is the smallest useful deliverable if the full result is blocked?
8. Where should the work resume or roll back if a node fails?

Record the answers as a compact `goal_contract`: `problem`, `audience_action`, `deliverables`, `truth_sources`, `constraints`, `success_criteria`, `minimum_deliverable`, `validation`, and `rollback_points`. Separately record an `output_contract` containing only explicit user constraints for quantity, format, length, language, result-only/answer-only output, and forbidden content. Resolve discoverable facts directly. Ask the user only when a missing choice would materially change the outcome or authorization.

## Route by complexity

- `simple_direct`: one quick step, no durable artifact, low truth/render/side-effect risk. Answer or act directly without displaying a ceremonial pipeline.
- `sop_required`: multiple steps or artifacts, source-truth risk, rendering/export, external side effects, user confirmation, long execution, or rollback needs. Load `sop-orchestrator` and use its node contracts.

For `sop_required`, work backward from acceptance to execution:

`完成证据 <- 验证 <- 最终产物 <- 生成 <- 结构 <- 真源 <- 路由`

Execute forward only after the backward design is decision-complete:

`路由 -> 解析 -> 结构化 -> 生成 -> 验证 -> 导出 -> 复盘`

Show the current state without turning progress reporting into a long status report:

`[路由｜🔄进行中] -> [解析｜⚪未开始] -> [结构化｜⚪未开始] -> [生成｜⚪未开始] -> [验证｜⚪未开始] -> [导出｜⚪未开始] -> [复盘｜⚪未开始]`

Allowed states: `✅完成`, `🔄进行中`, `⏸待确认`, `⛔阻断`, `↩回滚`, `⚪未开始`.

## Select the execution route

Choose skills, tools, and models by the goal, artifact type, truth-source needs, runtime constraints, and validation method. Prefer a specific domain or artifact skill over a broad controller. Do not route to a domain skill merely because it was recently used.

- For complex orchestration, load `sop-orchestrator`; read its registries only when the task needs them.
- For software implementation and debugging, load `reliable-development` after this controller has fixed the goal and acceptance contract.
- For Ping An enterprise-health A00-A11 production, load `enterprise-health-orchestrator`; it owns that domain state machine. This controller does not replace its business contracts.
- For Chinese replies and artifacts, load `native-chinese-expression` after facts and domain boundaries are fixed and before final wording.

If a needed skill, tool, or model is unavailable, say so and choose a verified fallback. Never claim availability from a registry entry alone.

## Gates and rollback

- Truth sources are not derived outputs. Mark unsupported content as an assumption, gap, or blocked input.
- QA is a blocking gate. Generation or a passing local check does not by itself prove completion.
- The final response must satisfy every populated `output_contract` field. “只给一句” means exactly one sentence with no heading, preface, alternatives, bullets, or trailing note.
- Preserve confirmed upstream nodes and user changes. On failure, return to the earliest responsible node and redo only affected downstream work.
- Do not retry an unchanged failure. For repeated failures or live runtimes, use `reliable-development` and its evidence-first recovery contract.
- Pause only when a user-owned decision or authorization is required. If the user already approved the requested implementation, do not add a redundant confirmation gate.

## Done check

Before declaring completion, read the goal contract back line by line and mark each item `met`, `partial`, or `not met`. Report implementation, focused checks, full regression, live acceptance, and production readiness as separate states. Name any unchecked edge and the safest next action.

For the detailed seven-node contract, source classes, registries, status semantics, and rollback behavior, read `sop-orchestrator/SKILL.md` and only the references needed for the current task.

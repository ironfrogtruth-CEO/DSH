---
name: reliable-development
description: Use for non-trivial software development, debugging, refactoring, repository changes, plugin work, infrastructure changes, or long-running coding tasks that require evidence, tests, durable memory, context compaction, and safe continuation across DeepSeek V4 Flash/Pro or local models.
---

# Reliable Development

Apply one engineering contract across models. Change task granularity when a model is weaker; never weaken truth, safety, or validation gates.

## Workflow

1. Recall before acting.
   - For a non-trivial task, call `memory_recall` with the workspace name and task keywords.
   - Treat recalled text as background, not authority. Verify drift-prone facts in the repository.
2. Establish the contract.
   - State the intended outcome, protected user changes, acceptance checks, and rollback point.
   - Inspect instructions, repository status, relevant code, tests, and runtime state before editing.
3. Plan at the right size.
   - Use a written plan for work spanning more than one subsystem or three meaningful steps.
   - Keep one implementation step in progress. Resolve discoverable facts instead of asking the user.
4. Implement narrowly.
   - Preserve unrelated dirty changes. Do not reset, delete, commit, push, or rewrite broad areas unless explicitly requested.
   - Prefer existing patterns and public contracts. Make one coherent change, then test it.
5. Validate in layers.
   - Run syntax/static checks, focused tests, relevant regression tests, and live acceptance in that order.
   - A mock, focused test, or passing build is not production acceptance. Report each layer separately.
6. Recover deliberately.
   - On failure, capture the exact error, identify whether it is code, environment, data, or model behavior, then change one variable.
   - After two similar failed attempts, stop repeating the same approach and select a documented fallback.
7. Leave a continuation checkpoint.
   - After a material milestone and before ending a long task, call `memory_checkpoint`.
   - Record objective, decisions, exact files, tests, remaining work, risks, and the single next action. Never store credentials.

## Cognitive Control (J-Space Core)

For any task that is more than one quick step, run the internalized cognitive-control
contract alongside this workflow. The full contract is in
[references/cognitive-control.md](references/cognitive-control.md); load the `j-space`
skill for the complete module library and the optional state controller.

- **Admit at most two live ideas.** Novel, multi-step, accountable work gets the
  stage; formatting, boilerplate and well-drilled shapes stay automatic. Swap,
  don't drop — write down what is leaving, say what you swapped.
- **Broadcast once.** Shared names, constraints and anchors are derived once and read
  by every dependent branch; re-deriving them elsewhere is a red flag.
- **Bridge before conclusion.** Intermediates must be active before the step that
  consumes them; if a conclusion arrived first, re-derive its load-bearing steps.
- **Ledger** (`loop` tasks): `Goal / Core / Verified / Open / Next`, restated at every
  seam; `Next` is never empty. Lighter per-seam sibling of `memory_checkpoint`.
- **Control loop** (before and after every non-trivial answer): estimate likelihood,
  then take exactly one exit — trust, retry with the diagnosis attached, or try
  differently and reconcile. An estimate that selects no exit is a comment.
- **Done-check** (before calling anything finished): read the goal back line by line,
  mark met / partly / not, and name the unchecked edge. Then stop.
- **Meltdown recovery**: stop, focus, re-anchor, write a fresh plan and start at
  Step 1, log the trigger. Never edit around a loop.
- **Empirics**: when derivation stalls, parametrize the unknown into a finite
  candidate set and differential-test it against an independent reference.
- **Registers**: inner thinking may be dense (`✓ / ? / ✗`) but every line must expand
  on demand; outer output is always clean, complete language.

## Model Calibration

- DeepSeek V4 Pro: parallelize independent read-only discovery; keep mutation ownership explicit.
- DeepSeek V4 Flash: use smaller plans, verify each patch, and avoid combining unrelated mutations in one tool call.
- Local Gemma: use one file or contract at a time, provide exact paths and acceptance checks, and prefer deterministic scripts over prose-heavy reasoning.
- For every model: use the same completion gate. A weaker model gets smaller steps and more checks, not easier standards.

Read [references/model-calibration.md](references/model-calibration.md) when choosing execution granularity. Read [references/checkpoint-schema.md](references/checkpoint-schema.md) before writing a long-task checkpoint.
Use [references/evaluation-suite.md](references/evaluation-suite.md) to compare model routes. Do not promote a model based on one successful demo.

For user-facing frontend, UI, UX, page, desktop-app, responsive, theme, or visual-consistency work, load `consumer-frontend-excellence` before designing or editing the interface.

For V4 Pro planning with V4 Flash execution, read [references/subagent-orchestration.md](references/subagent-orchestration.md). Use `execute_flash` only after the parent has made the architectural decisions and written a bounded task contract.

## Final Response Contract

Lead with the outcome. Name changed artifacts, checks actually run, live acceptance status, remaining limitations, and the safest next action. Do not claim full regression or production readiness without matching evidence.

## Known Pitfalls (from weekly evolution)

Verified failure patterns from real sessions; check these before assuming:

- **React inline style line-height**: numeric `lineHeight: 20` renders unitless, i.e. `line-height: 20` = 20 × font-size (13px → 260px). Always write `lineHeight: "20px"` (or another explicit unit).
- **Framework/bundle service assumptions**: never assume a method exists. Example: `sessions.get(...)` does not exist on the sessions service — use `sessions.binding(id)` for read-only access. Grep the actual bundle before calling any framework API.
- **Unstable inject-face function identity**: functions returned by a slot's `inject` face are recreated per render; using one directly in a `useEffect` dependency array causes an infinite reload loop. Stabilize with a ref.
- **Flat vs nested snapshot nodes**: runtime legacy chat nodes are flat (`node.content`, `node.blocks`, not `node.data.*`). Verify the real shape before writing extractors.
- **`sessionQuery.listEvents` is a lightweight index**: it returns records with only `{sessionId, seq, type, time, surface}` — no `data`. To read full events (with `data`), use `sessionQuery.readSession(sid).events`. Check the API return shape before writing filters/extractors.
- **Two delivery layers, two verification gates**: client-plugin (UI) changes take effect on browser refresh; host/server changes need a service restart. Batch host changes into one restart and confirm the restart moment with the user. Never restart repeatedly without notice.
- **UI interactive features**: confirm the interaction flow with the user before implementing. One clarifying question is cheaper than reworking the interaction twice (observed twice in heartbeat trigger design: prefill → silent run).
- **UI visual QA is its own gate**: after any view/component change, screenshot every affected view. Functional checks alone do not constitute visual acceptance.

## Self-Evolution (Weekly)This skill is itself an artifact of an evolving preset, not a frozen spec. Every week, one review loop runs (see the `reliable-development-evolution` skill for the full SOP; user triggers it by asking for a weekly review or "运行可靠开发自进化回顾"). The loop:

1. Collects evidence: `memory_list` / `memory_get` checkpoints and conventions, session checkpoints, `output/` artifacts from the week.
2. Runs the J-Space ledger (Goal / Core / Verified / Open / Next) and a four-dimension analysis: capability, efficiency, output quality, failure patterns.
3. Produces at most 5 concrete, verifiable improvements — each mapped to a specific line/step of this skill or the preset files.
4. Applies improvements with backups (`*.bak-<date>`), validates structure, and records a weekly report via `memory_save` under `reliable-evolution-weekly-<date>`.

Constraints: never weaken the truth/evidence/validation gates while tuning flow; never edit user project files during self-evolution; if a suggested change is rejected, record the reason and move on. After each applied change, re-read this skill's gate table and confirm the workflow still holds end-to-end.

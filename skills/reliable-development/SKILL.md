---
name: reliable-development
description: Use for non-trivial software development, debugging, refactoring, repository changes, plugin work, infrastructure changes, or long-running coding tasks that require evidence, tests, durable memory, context compaction, and safe continuation across DeepSeek V4 Flash/Pro or local models.
---

# Reliable Development

Apply one engineering contract across models. Change task granularity when a model is weaker; never weaken truth, safety, or validation gates.

For a complex engineering task, load `goal-first-control` first. It owns the goal contract, complexity route, pipeline state, and rollback map. This skill owns repository evidence, implementation, tests, runtime acceptance, recovery, and continuation.

## Workflow

1. Recall before acting.
   - For a non-trivial task, call `memory_recall` with the workspace name and task keywords.
   - Treat recalled text as background, not authority. Verify drift-prone facts in the repository.
2. Establish the contract.
   - Carry forward the goal contract: real problem, audience/action, deliverables, truth sources, constraints, success criteria, minimum useful result, validation, and rollback points.
   - State protected user changes, acceptance checks, and the current rollback point.
   - Inspect instructions, repository status, relevant code, tests, and runtime state before editing.
   - If a live service, worker, queue, or failed long-running task is involved, freeze its exact input, version, error, active ownership, and artifacts before the next mutation.
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
   - On failure, classify the responsible layer, create a stable failure fingerprint, and name what will change before retrying.
   - Retry only the affected unit or earliest affected node. Preserve confirmed upstream artifacts.
   - If the same fingerprint returns after one diagnosed retry, stop the loop and select a documented fallback or re-plan.
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

The active route is available to the persona as `{{provider}}/{{model}}`. When the provider is `ollama-local` (including the selectable `cybermarcus:latest` and `qwen3.6:27b`), automatically use the local lane: persistent bash plus `str_replace_editor`, one file or contract per mutation, immediate syntax/focused tests, bounded context, and explicit next-step fields. Gemma4 remains the backend visual fallback, FLUX remains the backend image route, and EmbeddingGemma remains the backend retrieval route; they are deliberately absent from the conversational model picker. TTS/STT remain tool capabilities routed through `/Users/marcus/.dsh/bin/dsh-local-ai`, not LLM model entries. DeepSeek routes retain the full strategy and may use the bounded `execute_flash` worker. This changes execution width only; truth, safety, ownership, QA, rollback, and completion gates stay identical.

For non-trivial development, use planner/executor separation by default. DeepSeek V4 Pro owns planning, architecture, integration, and acceptance. Online continuable children use `subagent_flash`; online one-shot workers use `execute_flash`; both run V4 Flash High. A local parent uses generic `subagent`/`subagent_fork` so children inherit the selected local route. Continuable calls must stay in their default background lifecycle (`run_in_background` omitted or true); never force them into foreground mode, because that disposes the child and removes the follow-up channel. Parent-to-child contracts, child `report` messages, and parent `send_message` follow-ups must remain usable. Child names come from the wider Marvel universe and are dynamically selected in the stable form `<漫威角色>·<职能>-<两位序号>`; examples are not a whitelist and names do not repeat inside one parent task.

CyberMarcus inherits the current Host skill/plugin surface: model-invocable Skills, Host tools and plugins, Ollama/DeepSeek routes, 虾缸 bridge/artifact/heartbeat tools, and scheduled-task tools. The current Web surface includes dsh-browser, dsh-dsbalance, dsh-git, dsh-memory, dsh-screen, dsh-shrimp-shell, zhipu-media, dsh-tool-policy, dsh-intelligence, dsh-code-intelligence, dsh-cross-session, dsh-frontend-qa, dsh-goal-first-state-machine, dsh-evals, dsh-compaction-v2, deepseek-idesign, and deepseek-ippt. Low-level live Cordis inspect/mount providers are Host singletons and are not exposed as `cordis_*` tools in CyberMarcus; use bash/fs plus doctor, profile, and architecture checks for configuration work, and use `execute_flash` for bounded specialist execution. Verify each capability in the live catalog before use; this statement is not proof that an optional provider is currently connected.

Read [references/model-calibration.md](references/model-calibration.md) when choosing execution granularity. Read [references/checkpoint-schema.md](references/checkpoint-schema.md) before writing a long-task checkpoint.
Use [references/evaluation-suite.md](references/evaluation-suite.md) to compare model routes. Do not promote a model based on one successful demo.

When an attempt fails, a live runtime is involved, or retries/restarts begin to accumulate, read [references/evidence-first-recovery.md](references/evidence-first-recovery.md). Its failure classification, fingerprint, mutation fence, and retry-scope rules are part of the completion gate.

For user-facing frontend, UI, UX, page, desktop-app, responsive, theme, or visual-consistency work, load `consumer-frontend-excellence` before designing or editing the interface.

For V4 Pro planning with V4 Flash execution, read [references/subagent-orchestration.md](references/subagent-orchestration.md). Use `execute_flash` only after the parent has made the architectural decisions and written a bounded task contract. All independent subagent work may run in parallel only after the parent fixes the goal, architecture, acceptance, dependencies, and exclusive ownership; every mutating child must own a non-overlapping file/module set and use a Marvel call sign plus function and number. The call sign never replaces the role or contract, and the child must start its final report with the exact assigned name.

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
- **A real run is not the default debugger**: freeze the failing sample and reproduce it with a fixture, replay, or focused harness before changing live code. Do not patch, restart, and submit another real run as one combined experiment.
- **QA protocol failure is not artifact failure**: truncated JSON, missing evaluator input, or schema repair belongs to the QA call. Retry that call or batch; do not roll back unrelated artifact nodes.
- **Never tune away the quality floor**: do not turn fact loss, missing required content, or invalid state into warnings merely to pass one sample. A global threshold or provider default needs independent regression evidence.
- **Control-plane changes need state invariants**: verify idempotency, active ownership, terminal-state monotonicity, cancellation propagation, lease heartbeat/fencing, and attempt-scoped evidence.
- **Service restart race on ports**: after `pkill` (or any kill of the old server), the port may not be released immediately; starting the new process too soon fails with `address already in use`, and the first request after restart can 504 even though the task was actually created. Poll `lsof -iTCP:<port>` until free, then start, then confirm the listening pid matches the new process. A `RUN STARTED: None`-style response is a signal to check the creation result, not a reason to continue blindly (observed on the 皮皮虾 7843 backend).
- **Live-run failure vs fixed-sample mismatch**: when a real run keeps failing but the same data passes the deterministic check offline (0 issues), suspect that validation ran on an early intermediate generation inside a retry loop, or that the failure is model-output nondeterminism — not the code. Freeze the intermediate state first, then decide what to fix. For nondeterministic model layout/QA output, move to a deterministic template (model fills content only) instead of stacking more repair patches (observed on 皮皮虾 layout/QA over rounds 1-3).
- **AI visual judgement can misreport**: vision models (e.g. 智谱 GLM on screenshots) occasionally hallucinate layout facts ("only two categories"). Treat AI visual review as an auxiliary signal only; layout facts must be settled by deterministic checks (playwright measurements, geometry assertions, real screenshots).
- **Heartbeat/timer tasks need an executable carrier**: the shrimp heartbeat ticker skips tasks with neither `runner` nor `pipelineSlug` at the top of every tick — they stay `nextRunAt: null` forever and never fire, with no history entry. A session-type recurring task (weekly review) belongs in a session `schedule_create` (kind `every`, scanned into the 心跳 panel), not in a carrier-less heartbeat record. Diagnose "no trigger" by reading the ticker's skip conditions before touching the record (observed 2026-08-25: 进化日记 heartbeat was a silent zombie since 08-21; "re-register to recompute nextRunAt" alone cannot fix a carrier-less task).
- **Group failure history by fingerprint**: heartbeat/runner failure history repeats the same JSON blob per attempt; the same `failure_fingerprint` appearing 2+ times in a row means one root cause is being retried, not fixed. Stop, preserve the exact error, change something effective, then retry once (observed 2026-08-24: article-5/article-7 gates retried 3-4 times over ~5.5 hours before the real backend bugs were found).

## Self-Evolution (Weekly)

This skill is itself an artifact of an evolving preset, not a frozen spec. Every week, one review loop runs (see the `reliable-development-evolution` skill for the full SOP; user triggers it by asking for a weekly review or "运行可靠开发自进化回顾"). The loop:

1. Collects evidence: `memory_list` / `memory_get` checkpoints and conventions, session checkpoints, `output/` artifacts from the week.
2. Runs the J-Space ledger (Goal / Core / Verified / Open / Next) and a four-dimension analysis: capability, efficiency, output quality, failure patterns.
3. Produces at most 5 concrete, verifiable improvements — each mapped to a specific line/step of this skill or the preset files.
4. Applies improvements with backups (`*.bak-<date>`), validates structure, and records a weekly report via `memory_save` under `reliable-evolution-weekly-<date>`.

Constraints: never weaken the truth/evidence/validation gates while tuning flow; never edit user project files during self-evolution; if a suggested change is rejected, record the reason and move on. After each applied change, re-read this skill's gate table and confirm the workflow still holds end-to-end.

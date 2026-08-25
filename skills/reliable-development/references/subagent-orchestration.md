# CyberMarcus Planner / Executor Orchestration

## Responsibility Split

- Parent DeepSeek V4 Pro is the default online planner: clarify intent, inspect architecture, decide the plan, define ownership, identify dependencies, set acceptance checks, integrate results, and run final QA.
- `subagent_flash` is the default online continuable executor. `execute_flash` is the one-shot alternative. Both use DeepSeek V4 Flash High and never become completion authority.
- When the parent route is `ollama-local`, or cloud access is unavailable and the user has selected the local route, generic `subagent` and `subagent_fork` inherit the selected local model.
- For non-trivial work, delegate independent bounded implementation/research/QA after the parent has made the plan decision-complete. The parent must not perform every independent node itself.

## Naming and User Notice

- Give every child a Marvel call sign plus a functional role and stable two-digit id. The pool is dynamic, not limited to a fixed shortlist. It may use Avengers, Guardians, X-Men, Fantastic Four, street-level heroes, and other Marvel characters, for example `蜘蛛侠·前端-01`, `钢铁侠·架构-01`, `美国队长·集成-01`, `奇异博士·研究-01`, `鹰眼·审计-01`, `惊奇队长·执行-01`, `火箭浣熊·性能-01`, `暴风女·QA-01`, or `神奇先生·算法-01`.
- Select a role-appropriate character, do not repeat a call sign inside one parent task, and keep the format `<漫威角色>·<职能>-<两位序号>`.
- Before the tool call, tell the user: “接下来由 <name> 负责 <task>; 主 Agent 负责 <integration/acceptance>.”
- Begin the delegation tool's `description` with the exact full call sign and then the short task; put the same name at the top of the child prompt, regardless of whether the route is `subagent`, `subagent_fork`, `subagent_flash`, or `execute_flash`. The durable description is also the parent status rail's primary display identity.
- Require the child's final report to begin with the assigned name.
- Before parallel delegation, announce the complete roster, owned files/modules, and dependency relationship.
- The call sign never replaces the role, exclusive file/module ownership, decision-complete contract, focused validation, or parent acceptance. A child must report a contract gap instead of inventing missing ownership or architecture.

## Delegation Contract

Every child prompt must contain:

```markdown
## Agent name
## Role
## Objective
## Owned files or module
## Inputs and known facts
## Required changes
## Constraints and forbidden changes
## Focused validation
## Expected report
```

Do not delegate “fix this”, “finish the feature”, or another goal that requires architectural decisions.

## Scheduling

- Start independent read-only or non-overlapping implementation tasks together.
- Give every mutating child exclusive file/module ownership.
- Run dependent tasks in phases: contract → implementation → integration → acceptance.
- Use foreground calls when the next parent action needs the result.
- Use background calls only when the parent can continue useful independent work; collect the result before integration.

## Runtime Message Channel

- Continuable children are the default whenever the parent may need clarification, a correction, or a second validation pass.
- Keep continuable calls in their default background lifecycle: omit `run_in_background` or set it to `true`. Never set it to `false`; a foreground call is disposed after settlement and cannot support later follow-up. If the parent needs the answer before its next action, wait for the settlement notice from the background child.
- Parent → child: the initial contract is the subagent prompt; later bounded corrections use `send_message`.
- Child → parent: the child returns its report through the continuable subagent report channel. The parent receives the settlement/notification in its own session before integration.
- Status: use `list_agents` for child identity and state. Do not send subagent ids to `job_output`; job ids and subagent ids are different namespaces.
- If a child report is incomplete, the parent sends one precise follow-up to the same child instead of spawning a replacement or silently doing the work itself.

## Acceptance

The parent must inspect the resulting diff, verify no ownership overlap, rerun integration-level checks, and perform live acceptance when required. Child claims are evidence inputs, not completion authority.

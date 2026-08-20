# V4 Pro Planner / V4 Flash Executor

## Responsibility Split

- Parent V4 Pro: clarify intent, inspect architecture, decide the plan, define ownership, identify dependencies, set acceptance checks, integrate results, and run final QA.
- `execute_flash` child: implement one bounded contract, run its focused checks, and report evidence. It does not redesign the system or declare the whole task complete.

## Naming and User Notice

- Give every child a functional, human-readable name with a stable short id, for example `前端实现代理·UI-01`, `后端执行代理·API-01`, or `测试验证代理·QA-01`.
- Before the tool call, tell the user: “接下来由 <name> 负责 <task>; 主 Agent 负责 <integration/acceptance>.”
- Put the same name in `execute_flash.description` and at the top of the child prompt.
- Require the child's final report to begin with the assigned name.
- Before parallel delegation, announce the complete roster, owned files/modules, and dependency relationship.

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

## Acceptance

The parent must inspect the resulting diff, verify no ownership overlap, rerun integration-level checks, and perform live acceptance when required. Child claims are evidence inputs, not completion authority.

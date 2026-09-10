---
name: consumer-frontend-excellence
description: 设计、实现、修复或视觉验收面向消费者的高质量 Web 与桌面界面：页面布局、导航、明暗主题、响应式、交互状态或 Figma 落地，且体验与代码质量同样重要时用它。
---

# Consumer Frontend Excellence

Build interfaces that feel intentional, clear, consistent, and complete. Treat aesthetics, interaction, accessibility, and implementation quality as separate gates that must all pass.

## Workflow

1. Ground the design.
   - Load `reliable-development` and `ux-visual-designer`.
   - If a Figma URL or node is the visual truth, also load `figma-implement-design` and fetch context plus screenshot before coding.
   - Inspect the running interface, relevant screenshots, existing components, tokens, fonts, icons, breakpoints, and theme behavior.
2. Define the user contract.
   - Name the primary user, job to be done, main action, error cost, and confidence needed before acting.
   - Map entry → scan → decide → act → feedback → recovery. Remove steps that do not help this path.
3. Lock the visual system.
   - Reuse the product's established tokens and components. Do not introduce a second visual language for one page.
   - Record type scale, spacing, radii, elevation, color roles, content width, icon style, and motion rules before broad implementation.
   - Read [references/consumer-visual-system.md](references/consumer-visual-system.md).
4. Design complete states.
   - Cover default, hover, focus, active, selected, disabled, loading, empty, success, warning, error, offline, and long-content states where applicable.
   - Keep one clear primary action per decision area. Every click must produce immediate visible feedback.
5. Implement with project conventions.
   - Extend existing primitives before creating new components.
   - Use semantic HTML, keyboard access, visible focus, accessible names, and reduced-motion support.
   - Centralize repeated values in the existing token system. Avoid scattered magic values and page-specific copies of shared controls.
6. Validate functionally.
   - Exercise every visible control and state with normal user input.
   - Check navigation, persistence, recovery, loading, empty data, long labels, and failed requests.
7. Validate visually in a separate pass.
   - Inspect the initial viewport, the densest realistic state, and at least one post-interaction state.
   - Check required desktop, compact desktop, and mobile sizes; for a desktop app, check the launched window and a smaller realistic window.
   - Check light and dark themes when the product supports both.
   - Capture screenshots and review hierarchy, alignment, spacing, clipping, contrast, typography, asset fidelity, and visual balance.
   - Read [references/visual-qa-gate.md](references/visual-qa-gate.md).
8. Preserve consistency.
   - Write confirmed design decisions to `memory_checkpoint` under `design-<workspace>` after a material UI milestone.
   - Record tokens, reusable components, intentional deviations, screenshots, tested viewports, and remaining visual debt. Never store credentials.

## C-End Quality Rules

- Make the first screen answer “where am I, what can I do, what happens next?”
- Prefer clear hierarchy and whitespace over card proliferation, decorative pills, and competing accents.
- Use real product language. Avoid backend field names, implementation terms, and unexplained status codes.
- Use one icon family and consistent stroke/optical size. Do not use emoji as product icons unless the brand explicitly does.
- Use gradients, glass effects, glow, and motion only when they reinforce brand or state; never use them to disguise weak hierarchy.
- Keep motion short and purposeful, normally 120–240 ms, and respect `prefers-reduced-motion`.
- Treat visible clipping, broken theme contrast, inconsistent components, or an unreachable primary action as blocking defects.

## Evidence Contract

Do not claim visual completion from code inspection or a passing build. Sign off only after real rendered screenshots and interaction checks. For formal QA, create a JSON manifest and run:

```bash
node scripts/check_ui_qa_manifest.mjs <path-to-ui-qa.json>
```

Use [references/frontend-evaluation-suite.md](references/frontend-evaluation-suite.md) to compare model quality or audit a major flow.

## Final Response

Lead with the visible outcome. List implemented screens/components, functional checks, visual checks, tested themes/viewports, screenshot paths, known deviations, and remaining risks. Separate code completion from visual acceptance.

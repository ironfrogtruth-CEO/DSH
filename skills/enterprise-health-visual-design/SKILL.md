---
name: enterprise-health-visual-design
description: Design visual components, image strategy, report VI, color constraints, and editable image layers for A4 enterprise health reports using the provided visual component library.
---

# 企业健康报告视觉设计 Skill

## Inputs

- Locked page plan in `内容框架.md`.
- Component rules in `组件选型规范.md`.
- Visual component library under `04_视觉组件外挂库/`.
- Approved brand, cover, top image, footer image, doctor/report-reading image, and activity-scene assets.

## Component Selection

Use components by information shape:

- proportions: ring, stacked ratio bar, proportional bar;
- ranking: percent-scaled horizontal bars, not row-by-row repeated captions;
- risk mechanism: one chain per page with behavior/environment -> abnormal indicator -> consequence -> service action;
- service methods: capsules for exact service names, service cards for target/action/context, product cards for goods/rights usage;
- annual configuration: risk integration canvas followed by service response blocks;
- interpretation: light orange paper-style report-reading module with label `解读`.

Use the page support matrix to adapt components:

- complete proportion data: ring, stacked ratio bar, percent-scaled horizontal bar;
- count or amount without denominator: table, metric story card, amount card, weak chip;
- no same-period comparison: current-year structure only, no trend or improvement chart;
- service name without usage data: service asset card or service capsule, no coverage/satisfaction chart;
- no photo or feedback: service fact module or topic path, no fake photo collage;
- sparse page: enlarge supported components, add semantic visual assets, or merge the page before rendering.

Component hard gates:

- Funnel: only same-population, sequential, narrowing user chains. Valid examples include 员工总人数 -> 被保险人数 -> 理赔人数 or 触达人数 -> 使用人数 -> 完成人数. Invalid examples include male/female, age bands, departments, product categories, 门诊/住院/重疾, and account categories.
- Stacked ratio/pie: only mutually exclusive parts with the same denominator and one clear total. Do not mix employee counts, money, service times, and percentages in the same composition component.
- Ratio scale bar: only 0-100% rates such as 检出率、使用率、满意度、覆盖率、完成率、赔付率. Counts and money cannot be scaled as 0-100%.
- Claim/amount story: use for money by scene or口径隔离; never place medical-cost, account, and employee-count facts in one “proportion” visual.
- Risk chain/risk board: use actual TOP risk names, rates, affected people, and matched service actions. Do not display field names such as 主要证据字段 or process labels.

Never use one static layout for every enterprise. If a component fallback changes visible labels, titles, captions, or notes, update `内容框架.md` before HTML generation.

Component rendering must consume the locked page-plan particles:

- Use `focusItems[]` to decide what is primary, secondary, or annotation-level information.
- Use `componentCopyItems[]` as the only source for component labels, values, captions, and grouping.
- Do not render the same metric once as a standalone big-number card and again inside the selected component.
- If the selected component has no matching renderer class or `data-component="report.xxx"` DOM, treat it as a component-library gap and add the style before export.
- Plain numbered paragraphs are not valid renderers for service, value, risk, funnel, matrix, or case components.

## Visual Constraints

- Keep Ping An orange as the main action/risk color.
- Use gray for neutral comparison and green only for clearly positive or low-risk signals.
- Keep typography readable for printed A4 and older readers.
- Avoid one-character line breaks, misaligned capsules, cramped tables, and decorative icons without meaning.
- Ordinary pages use editable top images; cover and closing page are fixed by the approved main visual.

## Image Rules

Use matched scene images, not placeholders. Activity scenes must visibly match service activities. If no trusted activity photo exists, use approved stock/generated medical service imagery and record the source in the working file, not as client-facing copy.

## Output

Update `组件选型规范.md` and pass a component/asset plan to `enterprise-health-report`.

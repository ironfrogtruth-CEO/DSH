---
name: enterprise-health-page-plan
description: Convert the approved storyline into a locked page-by-page content framework with all visible text, component-visible copy, notes, and service names before HTML generation.
---

# 企业健康报告逐页稿 Skill

## Preconditions

Use this after data analysis and storyline approval. Do not generate HTML from a partial page plan.

## Page Plan Contract

Every substantive page in `内容框架.md` must include:

- page eyebrow;
- title and subtitle;
- page task;
- focus information plus `focusItems[]` with numbered items, labels, values, reasons, and source fields;
- core measures;
- recommended components;
- management component design;
- component-visible copy plus `componentCopyItems[]` with labels, values, captions, and grouping;
- `interpretationPrompt` for the report-reading node;
- `notePrompt` for the page-note node;
- report interpretation bullets;
- page notes or口径 explanations;
- source fields from the single data table;
- service names exactly as confirmed.

Every page must also include its data-support decision:

- required fields;
- optional fields;
- support status: `full`, `partial`, `merge`, `drop`, or `blocked`;
- missing-data handling;
- primary component and fallback component.

If support status is `merge`, move the supported evidence and visible copy into the target page and remove the standalone page. If support status is `drop`, do not keep a client-facing page, card, note, or sentence that explains the missing data. If support status is `partial`, write only the supported conclusion and choose a downgraded component rather than forcing a fixed visual template.

## Per-Page Data Interpretation

Each content page must perform a fresh page-level distillation before writing visible copy:

- identify the 3-8 fields that answer the current page task;
- group related fields by business meaning, not by “what exists in the table”;
- emit those fields as `focusItems[]` before component selection;
- select the component from the grouped information shape;
- emit `componentCopyItems[]` that matches the selected component; do not leave the renderer to infer labels from a prose paragraph;
- write 2-3 report interpretation bullets; each bullet states one management judgment, action, or source boundary without repeating component numbers merely to fill the count;
- write `interpretationPrompt` that tells the AI node how to produce management interpretation from the current page data without repeating component numbers;
- write page notes only for terms, formulas, thresholds, or口径 that readers may not understand.
- write `notePrompt` that names only the terms or口径 to explain. Do not use notes for source declarations or process explanation.

Infer page evidence domains from page-task fields as separate semantic segments. Never concatenate `pageTask`, `blueprintTask`, title, or role without boundaries and then let a word at the end of one field match a metric in the next field. In particular, commerce purchase-user counts remain commerce evidence unless the page independently asks for employee population structure; population-base pages must still bind explicit population evidence.

For a multi-domain page, count already-bound exact evidence toward each domain quota before adding topical context. Reserve capacity for every still-uncovered domain; an early domain must never consume the whole evidence budget and crowd out a later risk, service, claims, survey, population, or commerce domain.

If the local system rebuilds or narrows a page evidence package after model copy returns, revalidate every component `dataBindings[]` against the current package. Remove only stale bindings, deterministically refill a component only when it becomes empty, and retain a normalization audit. No renderer may consume an earlier prompt's evidence IDs after the current page contract changes.

Do not repeat the same sentence across cards, interpretation bullets, notes, and component descriptions. A page fails if the same management sentence appears more than once.

When a page title contains an explicit count such as `三类`, `四项`, or `六步`, write the subtitle as the exact peer-item list separated by `｜`. The item count must equal the title count. Do not replace the promised list with employee counts, money, rates, or another set of metrics.

Interpretation copy must use content-specific conclusions, not repeated reader-question templates or internal work labels. Prefer direct labels such as `高龄员工是当前重点`, `住院是主要资金压力`, and `服务要跟到就医结果`; do not repeatedly use `为什么……/怎么……`, and do not expose `管理判断`, `费用判断`, `资金判断`, `配置原则`, `管理边界`, or `落地要求`. If the rest of the page does not already explain the action's cause, the first interpretation bullet must state the reason in its body before the action bullet, while its label still states the page takeaway.

When A03 supplies a verified national policy or diagnostic-guideline boundary, place a compact policy callout on the corresponding risk page. State the exact population, screening method, and doctor-decision boundary, then name the related service or follow-up action. Do not write a blanket “国家要求” for a subgroup when the source only defines a screening programme. On service-recommendation pages, make the service name the card heading; risk evidence belongs in the “对应风险 / 推荐理由” line rather than in the heading.

Client-visible narrative must state the current business judgment or a concrete management action. Do not expose report-production transitions such as `后续`, `铺垫`, `作为…基础`, `形成…基础`, or `用于后续`. Read adjacent-page context to avoid repetition, but connect pages through the business topic itself rather than describing page order.

Do not turn one absolute usage, reach, or participant count into a positive scale judgment. Phrases such as `已具规模`, `覆盖广`, `活跃度高`, or `已成熟` require a traceable year-over-year, period-over-period, target, or external benchmark in the same page evidence package. Without that comparison, state only the verified usage fact and the management action.

Never paraphrase exact population evidence as `大多数`, `过半`, `超几成`, `全员`, `全人群`, or `所有人`. Use the exact registered headcount or percentage from the same page evidence package, or remove the population-scale claim. Operational phrases such as `后续复查`, `后续监测`, `后续随访`, `后续评估`, and `后续资源调配` must be written as a direct current or annual action (`持续复查`, `持续监测`, `持续随访`, `持续评估`, `年度资源调配`) before the A07 raw gate.

If a page cannot produce at least three useful `focusItems[]` or three useful `componentCopyItems[]`, merge it into the adjacent supported page or downgrade the component. Do not output a page that renders as plain numbered text or as repeated big-number cards.

User funnel pages are only valid when the visible chain is a continuous same-population sequence, for example 员工总人数 -> 被保险人数 -> 理赔人数. If a page uses male/female, age bands, departments, product categories, 门诊/住院/重疾, or account categories, choose composition, proportion, table, or signal components instead of a funnel.

## Visible Copy Lock

The HTML generator must not invent any visible text. If a sentence, service label, chart title, note, or image caption is needed, add it here first.

## Notes

Use notes for terms, thresholds,口径, formulas, and source boundaries. Notes should be concise, line-broken, and placed according to the render rules. Do not use notes to hide missing data in the client-facing report.

## Output

Update `内容框架.md` until it can be used as the single visible-copy source for the editable HTML report.

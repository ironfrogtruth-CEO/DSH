---
name: enterprise-health-report
description: Create, revise, validate, and package Ping An Group enterprise health reports as editable A4 HTML/PDF. This is the single HTML-generation and editor skill for the production line. Use for 企业健康报告, HR/union/management health reports, A4 magazine-style health reports, data-to-action storytelling, page-specific components, source boundaries, free image insertion/resizing, top/footer image layers, opacity controls, and PDF-safe export.
---

# 企业健康报告

## Operating Mode

Use the “三省六部” workflow as a gate:

1. 内容省：identify truth sources, service sources, visual assets, and unsupported claims.
2. 行动省：plan story, page flow, component choice, and editor needs before generating.
3. 渲染省：block delivery until browser/PDF/editor QA passes.

Do not invent medical facts, service names, prices, cases, or national-average comparisons. If the local knowledge base or source files do not support a claim, label it as needing verification or remove it.

## Data Truth And Service Naming

For the production-line template, the only enterprise data truth source is:

`02_数据字段模板/企业健康报告_纯取数字段横版模板_2024_2025.xlsx`

Use the workbook as a single-sheet data contract:

- row 1 is the field-name/header row;
- row 2 is field explanation;
- row 3 is supported page/expression;
- row 4 is recommended source/material;
- row 5 and below are enterprise-year records.

Client-visible numbers must come from this table. Old PPTs, generated reports, screenshots, analysis prose, and sample HTML are not data sources unless the number has been imported into this table or the user explicitly confirms a source correction.

Ping An service names are also gated. Visible service names must exactly match one of:

- service names in the field table's service-related columns;
- names in the Ping An product/service knowledge base, especially `产品与服务目录.md`, `企业健康管理服务方案详解.md`, `服务建议与产品映射.md`, `数据分类与指标口径.md`, `检测中心与专病筛查服务.md`, and `企康通产品与服务补充.md`;
- a user-approved service name.

Do not improvise service names, translate them into synonyms, or turn generic actions into fake Ping An service products. If a desired action lacks a confirmed service name, keep the action in working notes and ask for catalog confirmation before it becomes visible copy.

This skill supersedes the old separate 16:9 HTML editor for this template. Do not call any separate HTML editor skill for enterprise health report HTML; all A4 report editor capabilities must live here.

## Required Workflow

1. Parse inputs into source categories: enterprise data, Ping An service knowledge, institutional background, visual assets, and user constraints.
2. Build a storyline for HR/union readers: data finding -> business meaning -> risk if unmanaged -> practical service/action -> decision value.
3. Plan each page before rendering. Each substantive page needs:
   - page task, focus information, core measures, recommended components, management component design, page eyebrow/kicker, title, subtitle, body copy/report interpretation, component-visible copy, and notes written in the page plan before HTML generation;
   - one focus message;
   - data fields and interpretation;
   - a matched component, not a reused template by habit;
   - a page-specific explanation module;
   - no repeated page closing/summary strip. Page judgment and transition should live in the page report-interpretation module unless the page plan explicitly defines a special callout;
   - a left-bottom fixed note area for terms,口径, or caveats on ordinary A4 report pages, unless the page plan explicitly uses a local inline note.
4. Apply the page support matrix. The 2.0 framework is a dynamic skeleton, not a fixed page template:
   - `full` pages render normally;
   - `partial` pages render only supported modules and fallback components;
   - `merge` pages are folded into adjacent pages;
   - `drop` pages are not exported;
   - `blocked` pages stop generation.
5. Before generating HTML, lock the copy source: every visible text string in HTML must come from the page plan or source markdown. If a new sentence is needed, update the page plan first.
6. Generate editable HTML first. Use A4 fixed pages by default for enterprise health reports: `794px × 1123px`. Except cover and closing pages, target 75% meaningful coverage and enforce 72% as the hard minimum. Treat 72%-75% as `PASS_WITH_WARNING`; do not call the model again for that warning band.
7. Add editor capabilities from `assets/a4-health-editor.js` and `assets/a4-health-theme.css`.
8. Run QA with `scripts/validate_health_report.py` and browser/PDF rendering checks.
9. Package deliverables only after QA passes.

## Working File Structure

For this enterprise-health-report workflow, each company should have its own folder. The 贵州烟草 folder is the working template for future enterprise reports. A complete company folder contains:

- `内容框架.md`: report content framework, copy style, blueprint, and locked page-by-page visible copy.
- `工作流设计.md`: production workflow, file responsibilities, and execution rules.
- `数据分析.md`: truth sources, data inventory, source grades, analysis conclusions, and verified data.
- `组件选型规范.md`: visual component library usage, chart selection, icon semantics, and page-level component choices.
- `闸门控制.md`: content QA, copy QA, page-plan QA, and render/export gates.
- `原始文件/`: input folder for user-provided photos, screenshots, PDFs, tables, and raw materials for the specific enterprise.

For a new enterprise, create a new company folder with the same five Markdown files and an `原始文件/` folder, then fill `数据分析.md`, `组件选型规范.md`, and `内容框架.md` from the raw materials. HTML generation starts only after `内容框架.md` has a complete page plan and passes `闸门控制.md`.

Do not put long QA tables into `内容框架.md`, and do not put customer-visible page copy into `数据分析.md` or `组件选型规范.md`. HTML generation must treat `内容框架.md` page plans as the visible-copy source of truth.

## Output Path And Overwrite Rule

Enterprise report output is produced by the local project service:

- write reports under `outputs/{客户名称}/{报告时间}/`;
- name the HTML `{客户名称}_{报告时间}_{周期}企业健康报告.html`;
- place assets in the sibling `assets/` folder;
- write the generation date and QA summary inside the output metadata;
- regenerate by overwriting the same enterprise/time output folder after QA passes.

For template sample outputs, mirror the current report under `【模版】企业健康报告生产线/05_样例产物/{客户名称}/` using the same filename and asset layout.

## Copywriting Style

Enterprise health reports should read like a management white paper, not a data dump:

- Use a `current state -> risk pressure -> management meaning -> service action -> deliverable` narrative.
- Let components carry numbers, labels, service names, and field facts; let body copy carry judgment, pressure, transition, and management meaning.
- Moderate pressure is allowed when supported by data. Phrases like `不能止步于报告发放`, `管理要前移`, `必须排进年度节奏`, or `否则只停留在一次活动` are acceptable when the page data warrants them.
- Do not use fear, unsupported effect claims, direct renewal language, or fabricated national/industry comparisons.
- Customize the opening and key transitions to the client and industry. For 贵州烟草, use 贵州烟草 and 平安集团 consistently; never expose placeholders such as `某烟企` or wrong brands such as `平安好医生`.
- Avoid AI-shaped copy: self-questioning, page-self-explaining lines, generic summary phrases, and formulaic `不是...而是...`, `本页用于...`, `这一页不是...`, or `不能只...` structures. Rewrite into direct business judgment: data pressure -> unmanaged consequence -> next-year action.
- Do not repeat component numbers in paragraphs. If the component already shows the value, the paragraph must explain what that value means for management or next-year service.
- If a term is hard to understand, add a concise note. For A4 printed enterprise health reports, ordinary-page notes should use a consistent left-bottom note area with the last line aligned to the same coordinate across pages, unless the page plan explicitly defines a local inline note. Multiple notes must be line-broken.

## Page Design Rules

- Do not use self-questioning copy such as “本页回答什么问题” or direct renewal copy such as “为什么要续保”.
- Do not use generic labels like “领导可读结论”, “焦点字段设计”, “异常成因 / 进一步风险 / 缓解动作 / 服务接续”.
- Use content-specific labels that directly state the page takeaway, such as `高龄员工是当前重点`, `住院是主要资金压力`, `服务要跟到就医结果`, or `企业看进度，医生管诊疗`. Do not turn every label into `为什么……` or `怎么……`, and do not expose internal work labels such as `管理判断`, `费用判断`, `资金判断`, `配置原则`, `管理边界`, or `落地要求`.
- Do not invent elevated-sounding terms for ordinary ideas. For age structure, use direct wording such as `60 岁及以上员工`, `年龄结构偏大`, or `需重点跟进员工`; avoid awkward euphemisms or stigmatizing labels.
- Page titles must be short enough for print: keep each page title within 20 Chinese characters and 40 total characters including punctuation. Rewrite the title instead of shrinking the font.
- Every page subtitle must be present in the page plan/source markdown. Never let the generator improvise subtitles.
- If a title explicitly names a count such as `三类`, `四项`, or `六步`, the subtitle must enumerate exactly that many peer items. In this case, the list contract overrides the normal numeric-evidence subtitle rule; place metrics in cards or charts instead of substituting a different group of numbers.
- If the page outside the interpretation module does not already explain why an action is necessary, the first interpretation bullet must state the reason or problem before the next bullet states the action. Keep the label as a direct page conclusion; do not mechanically turn the reason requirement into a `为什么……` heading.
- Adjacent interpretation modules must answer their own page evidence and management question. Reusing the same `为什么…… / 怎么……` skeleton with only nouns changed is a QA failure.
- If a page has more than one note, render notes as separate lines: one `*term: explanation` per line.
- Do not render per-page closing/summary strips by default. Use the page report-interpretation bullets as the single editorial interpretation module unless the source plan explicitly defines another callout.
- If the page shows an improvement, explain what service or operating mechanism plausibly contributed, only when supported by sources.
- If the page shows a risk, explain what causes the abnormality, how it may worsen, and what health-management action can mitigate it. Risk-list pages must state concrete unmanaged consequences, such as gout attack, delayed nodule review, coronary heart disease, stroke, critical-illness exposure, or inpatient-cost pressure when supported by data and medical mechanism sources.
- Report-interpretation modules must display the short visible label `解读`; do not display the source field name `本页报告解读`. Render interpretation copy as simple bullet points by sentence/viewpoint. Use `strong` only for key information, and add theme-orange emphasis to `strong`; the rest of the body must stay normal weight across Chrome, Safari, and print preview.
- Report-interpretation modules are the only strong editorial annotation frame by default. Other business module frames should be visually weaker, with lighter borders/shadows and less saturated fills, so they do not compete with the report-interpretation frame.
- Use real matched assets for blank areas: activity photos, doctor communication, report interpretation, medical room, app/service entrance, dashboard, or service scene. Do not use placeholder images.
- To-enterprise activity photo areas should use image ratios that read like real scenes. When placing two photos in one row, prefer about `3:2` per image and include scene/value labels; do not use narrow strips that only show cropped pictures and pills.
- When a page has an awkward blank area, solve it with a semantic component or asset from the visual component library first: health-record flow, follow-up calendar, loop arrow, report-reading doctor, activity photo, medical grid, risk-control canvas, four-block service response, or service pathway. The added visual must explain a page logic point, not merely decorate the page.
- Keep bottom whitespace intentionally available only when the page has a planned footer image layer.
- For claims/medical-use pages, do not only list claims data. Cross-analyze service volume, service channel, outpatient/inpatient/critical-illness costs, and matching service actions: outpatient = high-frequency daily burden, inpatient = high-cost care pathway, critical illness = low-frequency high-impact disease entry.
- If a claim/service channel has only counts or time data, do not infer channel-level amount. State the usable channel facts and connect amount analysis to the verified outpatient/inpatient/critical-illness cost fields.
- Do not render missing-data reminder cards in the client-facing report. If a field is unavailable, remove that visible component and keep the boundary only in the working plan or QA notes.
- Missing-data language must never appear in visible body copy, annotation boxes, or component cards. Replace unsupported cards with analysis supported by verified fields, or remove the card.
- Separate component copy from editorial body copy. Components carry facts, values, fields, service names, and labels; body copy should carry judgment, transition, and management meaning. Do not restate the same numbers and service list in paragraph form after the component already shows them.
- For magazine-style pages, turn management logic into visible design: use pathway cards, icon flows, proportional bars, rings, matrices, and annotated tables instead of relying on paragraphs to explain the logic.
- Align pills, tags, and small action buttons within the same card group. If cards have uneven text lengths, anchor the pills to the bottom of each card so the row reads as one designed component.
- Component granularity matters:
  - Use capsules only for short service, product, action, or deliverable names such as report interpretation, uric-acid review, medicine, device, review calendar.
  - Use service cards when a service needs target population, action, service item, or deliverable context.
  - Use product cards for health-account goods or rights usage such as medicines, devices, nutrition/health products, and service entrances.
  - Use metric story cards for important numbers; each must include the value, label, and management meaning.
  - Use weak metric chips for low-priority supporting figures such as claims timeliness.
- Do not leave editorial body copy as unstyled paragraphs. Sparse pages may use a “doctor reading/report interpretation” module with a matched local medical/report asset; dense pages should at least use a restrained editorial note frame.
- Use one unified annotation style per page. Do not split two body paragraphs into two same-color annotation boxes. Report-interpretation modules should use a simple frame with no decorative left strip; if a doctor/report-reading image is used, place it inside the same frame on the right side.
- Use a light orange paper-style annotation treatment for report interpretation when suitable. The label, bullets, and bold emphasis are part of the QA gate; do not substitute a blank framed paragraph or a dark summary strip.
- If a doctor/report-reading image is used inside report-interpretation modules, keep its width consistent across ordinary pages. Default to a fixed right-side image column around 118px on A4 pages; do not let page-specific CSS shrink it to solve crowded layouts. If the page is crowded, rebalance upstream components or split cards instead of compressing the doctor image.
- Report-interpretation modules are the only strong paper-style editorial frame by default. Other business modules should use weaker borders, shadows, and fills so they do not visually compete with the interpretation frame.
- When a service-action section has five cards, prefer a balanced 3+2 layout: three cards on the first row and two stretched cards on the second row, with both rows occupying the same visual width. Do not leave the second row short or floating.
- Do not repeat sort/measure captions on every row of a bar chart. If a chart is sorted by detection rate, state it in the component title, page note, or page plan, not under each row.
- Keep color semantics consistent across the report: orange means emphasis, pressure, risk, or action-needed; gray means neutral comparison or non-emphasis; green means improvement, low-risk, or explicitly positive service signals only. Do not use a one-off blue/green/orange palette shift unless the page plan defines that semantic mapping.
- Use the main orange visual language for large takeaway, handoff, service-configuration, and thanks blocks. Avoid dark navy/black/gray blocks for these areas unless needed for cover contrast or photo readability.
- Service-object segmentation pages must answer three visible questions: what signal to watch, which employees to follow, and how to follow. Do not stop at age/sex proportions or pile up population labels; use entrance metrics, focus-signal cards, and a follow-up path.
- Component names must be business-readable. Avoid abstract internal names such as `前置风险桥`, `焦点字段`, or `服务触达设计`; use concrete labels such as `费用前置管理入口`, `复查提醒入口`, or `服务跟进路径`.
- Account or marketplace behavior labels must be reader-clear. Prefer `服务入口` for online/offline access mix and `权益用途` for treatment-equipment/prevention-health mix; add notes that these are group-level usage signals, not individual consumption preferences.
- Claims timeliness must explain its management meaning: it is a service-experience/process-stability indicator, not a health outcome. Connect it to workflow assistance, benefit-use willingness, and follow-up service access when supported by age/service-channel data.
- Claims timeliness is not the main value story. On claims/cost pages, prioritize verified medical-spend changes, absenteeism conversion, and total HR benefit when those fields are source-backed; show timeliness only as a visually weak process-experience chip.
- Claims/cost pages should include a business-readable claims table title such as `年度理赔申请`. Outpatient, inpatient, and critical-illness cards should use causal scenario cards: pressure source -> why it needs management -> matching service actions. Do not use a single arrow sentence that leaves the management logic implicit.
- Insurance/coverage pages must separate `保障责任额度` from `实际医疗费用结构`. Coverage/risk limits show responsibility-limit or average-insured-amount口径; cost bars show verified outpatient/inpatient/critical-illness spend. If the same population is covered by multiple responsibilities, collapse the repeated headcount into a single `覆盖口径` note instead of repeating it under every row.
- Coverage/cost pages should not use an unexplained timeline or abstract path. Use a reader-facing `这张图怎么看` or equivalent logic module: `先看兜底责任额度 -> 再看门诊/住院/重疾实际费用 -> 最后把体检解读/慢病管理/就医协助前置`. This module explains reading order and management logic, not project schedule.
- If a page uses enterprise health-account or entrusted-account figures, keep `委托余额` and `委托使用` in one account-rights module, and keep policy `理赔金额` in a separate claims-spend module. Use `使用` for account rights; do not write client-facing labels such as `委托消耗`, `集账消耗`, `个人额度消耗`, or `消耗分析`. Explain that entrusted-account use is enterprise health-account usage, while policy claims are insurance payout amounts; do not combine them in one ratio bar.
- Account-rights interpretation must state what the split means for management, for example whether personal quota is being activated and whether collective-account usage carries the main burden. Claims-spend interpretation must state where policy payout pressure appears, such as outpatient, inpatient, or critical-illness payout. Do not combine these two口径 into one proportion bar.
- When both account behavior and to-enterprise/service-touch content exist, place that page immediately after the coverage/cost baseline page. It should connect employee self-management demand and onsite touchpoints to the prior conclusion that costs need upstream management.
- Opening judgment pages should avoid unexplained service/action capsules and `01/02/03/04` timelines. If follow-up actions such as interpretation, uric-acid review, BP monitoring, or lifestyle intervention are needed, express them in the report-interpretation frame unless the page plan explicitly defines a separate component rationale.
- Report-interpretation typography must be browser-stable across Chrome, Safari, and print preview: only marked emphasis (`strong`) should be heavy; the full body must not inherit global bold weight. Fix layout by setting a stable right-side image column and sufficient frame height, not by shrinking the doctor image or compressing line-height.
- Report-interpretation copy must be business judgment, not production commentary. Ban client-visible phrases such as `不是新造概念`, `不是在堆数据`, `本页用于说明`, `这一页不是`, and source/process traces. Rewrite them into direct risk, pressure, and next-action statements.
- Before detailed major risk-chain pages, add a risk-chain judgment page when the report has multiple chains. It must show which prior evidence domains create the chains, such as physical exam abnormalities, population structure, medical-cost exits, health-account behavior, and to-enterprise/service-touch signals.
- To-enterprise/service-touch pages with both service capsules and an NPS/recognition metric must visibly separate them, for example with `｜`, so service pills never obscure the metric label such as `员工认可健康管理价值`.
- When current raw images cannot be located but the user confirms an older report/material generated from the same knowledge base, that older report material may be used as a secondary source. Mark the source in the working plan, but do not expose source-retrieval caveats in the client-facing report.
- Service continuation pages must tell the reader: what service continues next year, which risk or population it serves, and how it mitigates the issue. Do not write page-self-explaining copy such as “this page is not showing...”.
- To-enterprise service pages should use real activity photos, verified service themes, and any source-backed user feedback. If signup, coverage, or satisfaction fields are not present, do not invent those percentages.
- Next-year service configuration must be shown as risk source -> service name -> mitigation logic -> annual management material. Service cards that only list service names are not sufficient.
- Prefer a risk-control canvas for “how risk is reduced”: risk inputs, control actions, reduced-risk outputs, and management deliverables. Do not rely on a simple funnel when it does not explain the control mechanism.
- For “what services reduce risk”, avoid client-facing tables. Use a quadrant/four-block service response, service cards, product cards, aligned service/product capsules, and deliverable cards.
- Split next-year service configuration when needed: one page explains how report findings enter the Ping An health-management service framework; the next page lists concrete services, target risks, and execution actions. Avoid repeating the same service list across both pages.
- When splitting next-year service configuration, the first page must integrate prior findings by data domain and risk type, then state Ping An Group's risk-management framework such as `识别风险 -> 解释风险 -> 提醒复查 -> 接入医生 -> 留痕复盘`. It must not list the full concrete service catalog.
- The second service-configuration page is where concrete Ping An service items are matched to risks, target populations, and execution actions. Do not repeat the first page's risk-input explanation as another service list.
- In the first service-configuration page, call reusable offline outputs `年度管理材料` rather than abstract/internal labels such as `离线管控工具`.
- In the second service-configuration page, do not put a separate visible `交付物` segment inside every service card when the user asks to focus on services and actions. Use service/product/action capsules in the cards; place checklists, calendars, ledgers, and review reports under `年度管理材料` or notes when needed.
- Service pathway pages must not be a left sentence arrowed to a right sentence. Use service-asset cards that show what was done, what employees gained, and what continues next year.
- For major risk mechanisms, prefer one page per chain. Metabolic, cardio-cerebrovascular, nodule/影像, and critical-illness risks should show `behavior/environment factor -> enterprise abnormal indicator -> risk consequence -> Ping An service action`. Do not squeeze several unrelated chains into one page or leave the mechanism in paragraph copy only.
- Risk-chain endings must look and read like a warning, not a neutral result label. The middle service-action area needs a titled wrapper such as `持续检测与代谢干预`, `重点监控与慢病随访`, or `前置筛查与复查跟踪`, with service names shown as aligned capsules or service cards.
- Indicator explanation tables must be actionable: the indicator column uses the full abnormal indicator name such as `肥胖或超重`, key thresholds in the abnormal-standard column are visually highlighted, and service actions are rendered as aligned pills/capsules. Do not put the abnormal indicator name only in the enterprise-data column.
- Typography and print rules are gates: keep body text large enough for older readers, avoid one-character line breaks in headings/cards/capsules/table cells, center table headers both horizontally and vertically, and keep pills aligned in grids. Page occupancy means avoiding large blank areas, not compressing content into 75%; do not shrink components or fonts when there is no bottom overlap.
- When a local visual component library is provided or available, use it as a real design resource before falling back to generic cards. In this standalone project, consult `resources/component-library/` and `resources/component-library-full/`; icons, component references, and inactive/active assets may be used when they fit the page expression. Package chosen assets into the report folder and select them by meaning, not decoration.
- Claims tables must not repeat the same field with a synonym column. Render one row as field label + value, with a business title such as `年度理赔申请`; remove extra visible text such as `理赔服务使用人数`, `提交申请次数`, `已进入理赔人群`, or `服务处理规模` unless it is a distinct sourced field.
- Risk-list cards and indicator-action cards must align service/action capsules to the card bottom. `如果不跟进` / `如果不管` consequence boxes align to the top within their card group, so different text lengths do not create uneven component bottoms.
- The production workbench `report.html` must expose a background-image upload entrance in the page-plan step. The entrance must state the rendering rule: recommended 794x1123px or higher portrait image; cover and closing pages use the full image; ordinary pages crop the middle into a 793x220 top image at 75% opacity. Replacement, deletion, and opacity changes synchronize globally for ordinary-page top images.
- In `report.html`, the generation step only presents preview and generate-PDF actions. Do not expose separate buttons for generating HTML, component/image alignment, image completion, or PDF-prep. The final review step only presents audit and preview actions, with the reviewer label `B端服务响应室`.

## Component Guidance

Use flexible components based on message shape:

- proportion/risk: bar, stacked bar, risk proportion, gauge only when axis meaning is unambiguous.
- year comparison: slope chart, dumbbell, before-after cards, waterfall, or reduction callout.
- composition: donut, stacked ratio, matrix, table, cards.
- risk progression: funnel, pyramid, chain, timeline.
- service mapping: service cards, service-asset cards, quadrant/four-block service response, annual-management-material cards, responsibility timeline.
- segmentation follow-up: entrance metric + focus-signal cards + follow-up path.
- next-year service configuration: risk-control canvas for “how risk is reduced”; quadrant/four-block service response for “which services reduce risk”; annual-management-material pipeline for outputs.
- proof/evidence: dual-proof, evidence split, photo collage, app screenshot area.
- visible assets: use library icons for service/medical concepts, use photo collage for real service touchpoints, and use component-library references to avoid repeated plain metric cards.

Risk color rule: green means improvement or safe/low risk only. Do not place high-risk values in green zones. If a value means “high-risk population share”, use red/orange risk language and a neutral/gray baseline.

For reusable component details, read `references/component-system.md`.
For business risk tiering and service-combination rules, read `references/business-risk-mapping.md`.

## Editable HTML Requirements

Every generated HTML report must support:

- editable visible text;
- current-page free image insertion;
- inserted image drag and 8-point resize;
- width/height input for selected image components;
- image fit: `cover`, `contain`, `fill`;
- image opacity;
- replace selected image;
- double-click replacement for every image-like object: ordinary images, report-interpretation doctor images, onsite photos, free inserted images, top image layers, and footer image layers;
- image replacement must use one reusable file-input trigger and clear the input value before every click, so replacing with the same file twice still fires `change`;
- replacement must support both `<img src>` and CSS `background-image` targets, including photo-card/activity-card style components;
- layer up/down;
- delete selected component;
- per-page `793px × 220px` editable top image layer for ordinary A4 pages, using cover/brand visual language and default `75%` opacity; replacing, deleting, or changing opacity on any top layer should globally update/remove all ordinary-page top images;
- do not hard-code the top image opacity with CSS `!important`; the editor opacity control must be able to globally override all ordinary-page top images;
- optional per-page `793px × 300px` footer image layer for ordinary A4 pages; keep insertion/replacement/cropping/opacity editing capability, but do not force the footer image to display when the content page is fuller;
- if content occupies the bottom `300px` region or the page uses a left-bottom notes area, hide that page's footer image but keep the editable footer layer available;
- footer image opacity and footer image top/bottom opacity controls for bottom-to-top linear fade; changing these controls on any page footer layer should globally sync all page footer layers;
- footer images must use cropped display, not squeezed display, and should preserve the upper part of the image by default while fading from transparent top to fully opaque bottom;
- the editor toolbar should be collapsed by default: only the edit switch is visible until editing is enabled, then controls show in one compact top row;
- PDF export with toolbar, handles, selection outlines, and guide elements hidden.

Use `templates/a4-health-report-template.html` as the portable starter. The template loads:

- `assets/a4-health-theme.css`
- `assets/a4-health-editor.js`

## QA Gates

Block delivery if any item fails:

- page size is not fixed or print pagination breaks;
- the HTML is not written to `outputs/{客户名称}/{报告时间}/`, or the material lacks internal generation metadata;
- any visible HTML copy is not traceable to the page plan/source markdown;
- a generated page has a subtitle that is absent from the page plan;
- a page title exceeds 20 Chinese characters or 40 total characters;
- a per-page closing/summary strip is generated when the page plan only provides report-interpretation bullets;
- a report-interpretation module lacks the visible short label `解读`, is rendered as one dense paragraph instead of bullets, or uses emphasis styles beyond bold for key information;
- interpretation labels repeatedly use a `为什么…… / 怎么……` template instead of directly stating each page's takeaway, or the interpretation could be moved to another page without changing its meaning;
- a fixed left-bottom note overlaps the interpretation frame or another content component, or has no independent bottom safe area;
- report-interpretation body text renders all-bold in Chrome/Safari/print instead of limiting bold + theme orange to marked key phrases;
- visible text or key labels overflow circles/cards/buttons;
- a heading, pill, card label, table cell, or button has a single-character line break;
- body/table/note text is too small for printed A4 reading by older HR/union readers;
- similar text types vary wildly in size across pages, or sparse pages keep small text clustered in the upper half instead of using the A4 canvas;
- table header text is not centered in its cells;
- aligned pills/capsules drift vertically or horizontally within the same group;
- inserted images cannot be resized freely;
- double-clicking an existing image or image layer does not open replacement flow and keep selection/editor controls usable;
- inserted images have unwanted borders or placeholder styling;
- images insert on the wrong page;
- ordinary-page top image layer is missing, not `793px × 220px`, not editable, not defaulted to `75%` opacity, or replacing/deleting/changing opacity does not globally update/remove top images;
- footer image editing capability is missing, cannot create a `793px × 300px` footer layer when needed, cannot globally sync opacity/fade from bottom to top, or remains visible behind content/left-bottom notes when it should be hidden;
- ordinary-page notes are not aligned to a consistent left-bottom note area when the report plan requires fixed notes;
- core content on an ordinary page occupies less than the 72% hard minimum without a planned exception;
- the 75% meaningful-coverage target is pursued by selecting better evidence and content-fit components; never reach it by shrinking fonts, squeezing components, stretching components, or compressing doctor images;
- a page between 72% and 75% is treated as a warning-only pass and does not trigger another model call;
- editor controls are visible while edit mode is off, or the edit-mode toolbar wraps into multiple rows;
- a major risk chain page does not visibly show behavior/environment factor -> enterprise abnormal indicator -> risk consequence -> service action;
- a risk-chain service action is only paragraph text instead of service cards, aligned capsules, or an equivalent visible service component;
- a risk-chain terminal consequence is visually weak or lacks warning emphasis, or the service-action section has no titled wrapper explaining its management function;
- an indicator explanation table lacks full indicator names, highlighted abnormal thresholds, or service-action pills;
- a percentage/ranking bar is normalized to the highest item instead of using the actual percentage or verified composition;
- an entrusted-account module mixes `委托使用` with policy `理赔金额`, or uses banned labels such as `委托消耗`, `集账消耗`, `个人额度消耗`, or `消耗分析`;
- a risk-list page names risks without concrete unmanaged consequences such as gout attack, delayed review, coronary heart disease, stroke, critical illness, or inpatient-cost pressure when those outcomes are supported;
- green encodes high risk or creates risk misunderstanding;
- AI-ish banned phrases remain;
- coined or vague wording replaces direct business language;
- multiple notes are squeezed into one line instead of line-broken;
- detailed risk-chain pages exist without a prior risk-chain judgment page that connects the chains to physical exam, population, medical-cost, account-behavior, and service-touch evidence;
- coverage pages mix responsibility limits with actual medical-cost spend, omit the `覆盖口径` explanation for repeated covered headcount, or fail to explain why coverage amounts differ from outpatient/inpatient/critical-illness cost bars;
- health-account pages mix `委托余额`/`委托使用` with policy `理赔金额`, use account labels containing `消耗`, or fail to explain that entrusted-account use and insurance claims are different口径;
- claims pages only list data without outpatient/inpatient/critical-illness/service-action cross-analysis;
- a claims/cost page makes claims timeliness the main visual while source-backed medical-spend change, absenteeism conversion, or HR benefit fields are available;
- HR benefit calculations such as medical-spend savings plus absenteeism conversion are shown without source-backed formula notes;
- HR benefit or absenteeism conversion is shown without a visible `缺勤折算逻辑：` formula note when those values appear in the report;
- to-enterprise/service-touch capsules overlap or visually compete with an NPS/recognition metric, or the metric label such as `员工认可健康管理价值` is obscured;
- closing-page source lists expose local files, internal working knowledge bases, generated analysis documents, OCR/process artifacts, or self-created report material instead of client-safe source names;
- visible report includes a missing-data card, “not provided” explanation, or source-retrieval caveat for a field that should simply be omitted;
- editorial paragraphs repeat numbers/service lists already shown in components instead of adding judgment or transition;
- management logic is only described in paragraph text when a component is required to show the pathway, sequence, or mapping;
- service pathway logic is drawn as a simple left/right sentence arrow instead of service-asset cards or structured pathway blocks;
- editorial body copy is shown as plain free text with no magazine-style note, report-reading, or annotation treatment;
- a page shows multiple same-style annotation boxes for one body copy section, uses decorative annotation strips, or places report-reading doctor imagery outside/on the left of the annotation frame;
- row-level labels repeat the same sort caption such as “按检出率排序” for every bar row;
- color semantics drift within the same report, especially when blue/green/orange are used without a consistent meaning;
- vague account labels such as “使用结构/管理结构” appear without clear definitions;
- claims timeliness is shown without explaining why it matters to service experience or health-service follow-up;
- service pages do not specify next-year service continuation, target population, and mitigation logic;
- service mapping uses unsupported Ping An service items;
- service configuration is only a service list without risk source, mitigation logic, and deliverable;
- the page explaining risk reduction uses a funnel or arrow chain that does not visibly show risk input, control action, reduced-risk output, and management deliverable;
- the first next-year service-configuration page repeats concrete service lists instead of integrating prior data findings into a risk-management framework;
- the second next-year service-configuration page repeats the first page's framework instead of matching concrete Ping An service items to risks and deliverables;
- the page listing risk-reduction methods uses a client-facing table instead of quadrant/four-block service response, service cards, product cards, service/product capsules, and deliverable cards;
- service, product, and deliverable items are not visually distinguished;
- metric story cards show only large numbers without management meaning, or low-priority process metrics are shown as primary metric cards;
- the visual component library was referenced by the user but not consulted, or pages fall back to repetitive metric/explanation cards where a richer semantic component is available;
- a blank area is filled with meaningless decoration, an empty frame, or an unplanned placeholder instead of a source-traceable semantic component/asset;
- notes are detached from the agreed note strategy: for A4 enterprise reports this is usually a fixed left-bottom note area; if the page plan uses local inline notes, those notes must sit near the relevant component.

Run:

```bash
python3 scripts/validate_health_report.py path/to/report.html
```

Use browser screenshots/PDF export after the static validator. For long reports, inspect at least: cover, first data page, one risk page, one service page, one page with footer image, and closing page.

## Cross-Platform Packaging

This skill is portable. To move it to 扣子, 马维斯, WorkBuddy, or qclaw:

1. Copy the whole `enterprise-health-report/` folder.
2. Load `SKILL.md` as the main instruction.
3. Expose `templates/`, `assets/`, `references/`, and `scripts/` as local resources.
4. Preserve relative paths inside templates. Do not hardcode a personal home-directory path.
5. If the target product cannot run Python/Node, keep `validate_health_report.py` as a QA checklist source and run browser/PDF validation externally.

Read `references/compatibility.md` for platform-specific notes.

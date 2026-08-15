---
name: enterprise-health-storyline
description: Design the A06 enterprise health report storyline from verified A04 conclusions, A03 official evidence, and A05 recommendation decisions, producing a gated annual-blueprint.v3 JSON for A07.
---

# 企业健康报告故事线 Skill

## Preconditions

Use this only after A03 official evidence, A04 data analysis, and A05 recommendation mapping have passed their gates. Consume their structured JSON outputs through A00; do not read an old report, Markdown outline, or generated page as a truth source.

## Storyline Logic

Build the report from management flow, not from data-table order:

1. Who are the employees and what can the verified structure facts actually establish?
2. What risks are found by physical exam, claims, account behavior, and service-touch data?
3. Which verified risks and medical-cost structures need separate management attention?
4. Which risk chains have enough evidence for management action, without claiming future cost reduction?
5. What services have already touched employees and what must continue?
6. Which next-year service configuration can receive each verified population, and which participation, review, follow-up, or delivery records should be tracked?

## Page Count

Prefer 14 to 16 pages including cover and closing page. Add pages only when a distinct data domain, evidence shape, or recommendation decision would otherwise be compressed and unclear.

Page count must follow the page support matrix, not a customer-specific template. A page with `drop` or unresolved `blocked` status cannot appear. A `partial` page must be merged into a supported page or use narrower conclusions and components.

## Copy Rules

- Use direct business judgment with measured pressure.
- Avoid page-self-explanation and AI-shaped phrasing.
- Do not use renewal-sell language.
- Do not introduce numbers outside the field table.
- Service names must remain exact catalog names.
- Do not use HR, union, manager, or production-process labels in customer-visible copy.

## Claim Boundaries

- Inherit every `sourceBoundaries[]` and `blockedClaims[]` item from the approved analysis result. The blueprint may add a narrower page boundary but must never delete or rewrite an upstream item.
- A page may call an indicator high, low, broad, narrow, on-target, matched, or effective only when that page binds a same-definition benchmark, target, threshold, historical comparison, or effect-validation evidence ID. A report-level comparison flag is not page evidence.
- Every number in a page task, preliminary conclusion, or recommendation reason must come from that page's bound `evidenceIds`. A number available on another page is not allowed.
- YoY, MoM, prior-year, historical-period, trend, and change-signal language requires same-metric, same-denominator, same-period comparison evidence bound to that page. Otherwise omit the trend task and claim.
- Satisfaction is a fact about the valid questionnaire or valid evaluation sample only. Do not extrapolate it to all employees or use it to claim that activity design matched employee needs.
- A recorded no-offline close path is only a close-path fact. Do not call it effective diversion, replacement of offline care, or a treatment result.
- Service and product advice states the target population, management handoff action, delivery entry, and tracking indicators. It must not promise direct medical-cost reduction, health improvement, shorter waiting time, or proven service effect.
- Employee total is a population base, not service coverage. General service usage does not establish that a named risk cohort used that service. Purchase or personal-payment records do not establish activity level or willingness to pay.
- Fields marked simulated, estimated, inferred, unverified, or forbidden for formal reporting in `sourceBoundaries[]` or `blockedClaims[]` must not enter customer-visible tasks or conclusions.
- Every business subtask must be supported by that page's evidence IDs. Claims amounts, shares, or claim-scene evidence alone must not be expanded into disease-risk analysis; a combined risk-and-claims page requires explicit exam-abnormality, health-risk, or disease evidence on the same page.
- If a draft crosses a boundary, keep the traceable facts and rewrite the conclusion as a sample fact, close-path fact, or management handoff action before the blueprint gate runs.

## Output

Return `annual-blueprint.v3` JSON through the A06 output contract. It must include:

- page order;
- page role;
- page title/subtitle direction;
- focus data;
- risk/service/action transition;
- where each risk chain appears;
- where service configuration splits into “risk integration” and “service action”.
- the complete inherited `sourceBoundaries[]` and `blockedClaims[]`;
- only registered evidence IDs and recommendation candidate IDs;
- page-level support status and recommendation placement;
- a successful deterministic claim-boundary audit before A00 may dispatch A07.

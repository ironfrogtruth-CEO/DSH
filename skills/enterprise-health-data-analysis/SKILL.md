---
name: enterprise-health-data-analysis
description: Analyze enterprise health report data from the single-sheet field table, verify completeness, derive risks, cost and service conclusions, and prepare 数据分析.md for downstream page planning.
---

# 企业健康报告数据分析 Skill

## Truth Source

The only enterprise-data truth source is the user-uploaded file whose path and SHA-256 are locked by A01 and whose facts are confirmed by A02. `02_数据字段模板/企业健康报告_纯取数字段横版模板_2024_2025.xlsx` is the canonical field dictionary, not the only accepted physical layout.

A01 may normalize a standard four-row template, an ordinary wide table, a field/value long table, or a vertical key-value table into the same internal four-row contract. Analysis reads only `confirmedDataPackage`; it must not infer a source row layout or discard facts because the original data began on row 2.

Do not import numbers from old PPTs, generated reports, analysis prose, or screenshots unless they are present in the locked uploaded source or the user explicitly instructs a source correction.

## Analysis Tasks

1. Build a field inventory by data domain: population, physical exam, abnormal indicators, claims, outpatient, inpatient, critical illness, entrusted account, health account behavior, service touch, to-enterprise activity, and external references.
2. Mark required, optional, and blocked fields for each page.
3. Derive conclusions only from available fields:
   - risk finding;
   - affected population;
   - medical/cost pressure;
   - service touch or usage signal;
   - next-year management implication.
4. Classify each material risk as high, medium, low, or needs follow-up using the business rules in `enterprise-health-report/references/business-risk-mapping.md`.
5. Map physical-exam, claims, transaction/account, survey, and to-enterprise activity results to latent risk categories before proposing services.
6. Map latent risks to service combinations only after exact Ping An service names have been matched.
7. Separate enterprise data from external references. External references explain mechanisms; they do not replace enterprise data.
8. Keep missing fields out of client-facing copy. Missingness belongs in `数据分析.md` or QA notes only.

## Page-Level Evidence Distillation

Before page planning, create a dedicated evidence set for every substantive page. Do not reuse the same “many fields” bucket across pages.

- P3/P4/P5/P6-P14 must each receive its own primary fields, secondary fields, interpretation candidate, and component-fit note.
- A field enters a page only when it answers that page task. For example, a service page may use 到企、到线、到店 and商城 usage, but not employee gender unless the page explicitly discusses population composition.
- If the data source contains two periods, every page-level evidence set must include one of: year-over-year change, same-period structure, or explicit “current-year only” basis. Do not imply improvement without a comparable baseline.
- User funnel evidence must be a continuous narrowing chain from the same population, such as 员工总人数 -> 被保险人数 -> 理赔人数. Gender, age, department, disease category, 门诊/住院/重疾, product category, or account category must not be treated as a funnel.
- Same-denominator components require mutually exclusive parts and a clear total. If the numerator fields overlap or use different units, recommend a table, signal matrix, amount story, or separate cards instead.
- Never add detection, prevalence, abnormality, positivity, incidence, or participation rates when the underlying people may overlap. A slash-separated `综合风险TOPn主要证据字段` is a list of evidence field names, not a formula. Write each original field and report-year value separately. A combined count/rate is allowed only when an original field explicitly says it is deduplicated, or a registered derived metric provides a deduplication formula and `sourceFields`; preserve that original name and value exactly.
- If a risk name describes a gap or non-touch population while its evidence formula uses a positive numerator such as users, participants, or reached employees, do not relabel the ratio. Keep the confirmed original affected-person field when available, block the conflicting ratio, and request a denominator/direction confirmation.
- Interpretation candidates must state what the data means for HR,工会 or企业管理动作, not repeat the field name or explain the production process.

## Page Support Matrix

Before downstream storyline work, output a page support matrix with these fields:

- page id and page role;
- required fields and optional fields;
- field status: `full`, `partial`, `merge`, `drop`, or `blocked`;
- supported conclusions and banned conclusions;
- evidence grade;
- recommended component and fallback component;
- service-name status;
- missing-data handling.
- page-level interpretation candidates;
- page-level note candidates for cold terms, formulas, thresholds, or source boundaries.

Use the matrix to decide whether a page can stand alone. If a page lacks numerator/denominator, trend basis, service source, or activity evidence, do not create visible missing-data language. Downgrade the component, merge the evidence into a nearby page, or mark the page as not exported.

## Service Name Control

Service suggestions must be matched against Ping An service knowledge before entering the report. Use exact catalog names for visible service capsules/cards. If a useful action lacks a confirmed Ping An name, keep it as an internal analysis note and ask for catalog confirmation.

## Output

Update `数据分析.md` with:

- truth-source status;
- field completeness;
- confirmed conclusions;
- derived risk chains;
- formulas and calculation notes;
- service-mapping candidates with source names;
- blocked or downgraded conclusions.

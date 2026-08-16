---
name: sop-validate
description: Use this skill as the validate node in a harness SOP pipeline to enforce QA as a blocking gate for facts, schema, components, rendering, format delivery, source traceability, and user constraints.
---

# SOP Validate Node

Use this as node `validate`.

## Work

Run QA as a gate, not advice. Validate:

- input completeness
- source truth and citations
- schema and fields
- structure and coverage
- component/render constraints
- file format and export quality
- banned wording and user constraints
- rollback path

## Failure Categories

Use `sop-orchestrator/references/failure_taxonomy.json` for labels:

- input
- route
- schema
- component
- render
- qa_missing
- fact_position
- format_delivery
- domain_fit
- tool_model_availability

## Gate Rule

If QA fails:

1. Mark status `⛔阻断`.
2. Explain failure type.
3. Identify rollback node.
4. Do not export final deliverables.

## Stop Policy

Always stop on blocking QA failure.

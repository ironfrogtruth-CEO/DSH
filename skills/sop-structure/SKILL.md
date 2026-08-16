---
name: sop-structure
description: Use this skill as the structure node in a harness SOP pipeline to turn parsed inputs into schemas, outlines, storylines, page plans, field tables, component contracts, execution contracts, and confirmation-ready intermediate artifacts.
---

# SOP Structure Node

Use this as node `structure`.

## Work

Produce the structure that downstream generation must follow:

- schema or field design
- storyline or outline
- page-by-page draft
- component and layout contract
- data flow or process flow
- acceptance criteria
- source references and confidence labels

## Contract Rules

- Keep the structure compact and decision-complete.
- Attach source refs to factual claims.
- Mark weak facts as `待确认` or `需补证`.
- Do not generate final polished output before structure confirmation when the structure affects downstream direction.

## QA Gate

Block if:

- Required fields are missing.
- Structure does not map to the stated goal.
- Source refs are absent for factual claims.
- Component/render requirements are too vague for generation.

## Stop Policy

Stop for confirmation after significant outlines, schemas, page plans, field specs, visual contracts, or execution contracts.

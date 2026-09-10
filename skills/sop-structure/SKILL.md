---
name: sop-structure
description: SOP 流水线的结构节点：把解析后的输入转成 schema、大纲、故事线、页面计划、字段表、组件合同与可确认的中间产物。
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

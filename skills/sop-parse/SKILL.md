---
name: sop-parse
description: Use this skill as the parse node in a harness SOP pipeline to separate truth sources, derived outputs, debug notes, pollution risks, constraints, and open evidence gaps before downstream structuring or generation.
---

# SOP Parse Node

Use this as node `parse`.

## Work

Create a clean evidence map:

- `truth_sources`: originals and authoritative inputs.
- `derived_outputs`: generated or transformed material.
- `debug_notes`: temporary assumptions.
- `pollution_risks`: stale, wrong, outdated, or hallucinated content.
- `open_questions`: only questions not discoverable from local context.

## Source Map

For each truth source, capture:

- source id or path
- source type
- owner/user-provided status
- confidence
- usable facts
- must-review facts

## QA Gate

Block if:

- A derived artifact is used as the truth source.
- Important facts have no source.
- Stale templates or wrong terminology could contaminate downstream work.
- Missing evidence would materially change the final output.

## Stop Policy

Stop only if evidence gaps change scope, facts, or feasibility. Otherwise continue to structure.

---
name: sop-export
description: Use this skill as the export node in a harness SOP pipeline to package verified artifacts into Markdown, HTML, PDF, PPTX, PNG, CSV, JSON, or portable skill bundles while recording paths and avoiding unvalidated output.
---

# SOP Export Node

Use this as node `export`.

## Work

Export only after validation passes. Record:

- artifact type
- absolute local path when available
- source contract used
- validation status
- known limitations
- portability notes

## Supported Deliverables

- Markdown
- HTML
- PDF
- PPTX
- PNG/JPG
- CSV/JSON
- ZIP packages
- skill folders

## QA Gate

Block if:

- Validation did not pass.
- Export contains editor chrome or debug controls.
- Paths are missing for local files.
- Format does not match user request.
- Export shifted layout or lost editability when those were requirements.

## Stop Policy

Stop after export with concise delivery paths and local QA status.

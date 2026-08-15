---
name: enterprise-health-pdf-export
description: Export editable A4 enterprise health report HTML to PDF after browser QA, print QA, editor-control hiding, and file packaging checks.
---

# 企业健康报告 PDF 导出 Skill

## Preconditions

Use this only after `enterprise-health-report` has produced a validated editable HTML report.

## Export Gates

Before PDF export:

- open the report in a browser;
- verify A4 page size and pagination;
- hide editor toolbar, selection handles, guides, and debug labels;
- check cover, closing page, first data page, one risk-chain page, one service page, one account/claims page, and one page with notes;
- confirm Chrome/Safari/print-preview-compatible interpretation typography;
- confirm images are not squeezed, cropped incorrectly, or blocking notes.

## PDF Requirements

- A4 portrait;
- no browser headers/footers;
- all ordinary-page text readable in print;
- no visible local paths, internal knowledge-base names, placeholders, or missing-data explanations;
- source list client-safe;
- service names exact and catalog-backed.

## Output

Export PDF next to the HTML report and update the package README or delivery note with the output path and QA status.

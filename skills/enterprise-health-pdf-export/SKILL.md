---
name: enterprise-health-pdf-export
description: 在浏览器 QA、打印 QA、隐藏编辑控件与文件打包检查通过后，把可编辑 A4 企业健康报告 HTML 导出为 PDF。
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

# Skill Selection Policy

Use the most workflow-fit skill, not the most recent or most familiar skill.

## Selection Contract

For complex tasks, record:

- `selected_skill_ids`
- `why_selected`
- `fallback_skill_ids`
- `tools_needed`
- `model_candidates`
- `validation_skill_ids`

## Routing Rules

- **SOP/control**: use `goal-first-control`（以终为始）first, then `master-control` as legacy alias, then `sop-orchestrator` and node skills.
- **Review/work reports**: use `review-jianshibao`; use `pingan-work-review` only for Ping An-specific local knowledge work.
- **Editable 16:9 HTML report/PPT**: use `html-report-editor`; use `frontend-slides` for generic web slide decks; use `magazine-editor` for fixed-canvas A4/magazine style.
- **Knowledge-base ingestion/source trace**: use the project-specific curator only when the project path/domain matches; otherwise use generic file/OCR/PDF skills.
- **Visual assets/images**: use `imagegen` for generation/editing, `screenshot` for desktop evidence, `ux-visual-designer` for design judgment, `figma` or `figma-implement-design` for Figma.
- **PDF/DOC/Jupyter/audio**: use `pdf`, `doc`, `jupyter-notebook`, or `transcribe` by artifact type.
- **Browser/app QA**: use `playwright` for browser automation and `playwright-interactive` for persistent browser debugging.
- **GitHub/CI/code review**: use `gh-address-comments`, `gh-fix-ci`, or related GitHub skills by task.
- **Notion/Linear**: use Notion or Linear skills only when the target system is explicitly involved.

## Anti-Rules

- Do not route to a domain skill unless the user request or source path requires that domain.
- Do not use render skills before structure/source truth is confirmed.
- Do not claim future model/tool availability; use `model_registry.json` availability.
- Do not skip QA just because an artifact was generated successfully.

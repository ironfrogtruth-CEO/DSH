# Render Contract Policy

Render and design workflows must be registry-backed and QA-visible.

## Required Contract

When a task produces HTML, PPTX, PDF, image-heavy reports, or visual pages, structure should include:

- `visual_framework_registry`
- `component_registry`
- `framework_selection_contract`
- per-page `framework_id`
- per-page `template_id`
- per-page `component_ids`
- per-page `asset_ids`
- per-page `framework_source_refs`
- `background_strategy`

## Render Metadata

Final HTML should preserve selection metadata when possible:

- `data-framework`
- `data-template`
- `data-components`
- `data-asset-ids`

PPTX or other editable outputs should preserve equivalent framework usage metadata in shape names, notes, manifest, or sidecar JSON.

## QA Gate

Block delivery if:

- a page uses an unregistered framework/template/component/asset;
- visual choices are hidden in render-time code instead of emitted as a contract;
- source refs are absent for framework choices that depend on a knowledge base;
- final render lacks metadata needed to verify selections landed.

If this fails, roll back to the structure or generate node. Do not patch final HTML/PPTX by hand without updating the source contract.

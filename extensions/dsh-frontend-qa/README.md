# dsh-frontend-qa

Host-only, explicit design and visual QA contracts for DeepSeek Harness. The extension does not start a browser, inspect a running page, inject context, or edit UI files. The model must explicitly call one of:

Runtime requirement follows the current DSH Host runtime; the PNG provider has no third-party image dependency.

- `frontend_design_validate`
- `frontend_qa_validate`
- `frontend_visual_diff`
- `frontend_signoff`

## Manifest contracts

`schemas.js` validates `DesignSystemManifest.v1` with fonts, colors, spacing, radius, elevation, icon, motion, and breakpoint tokens. It validates `DesignQAManifest.v2` with viewports, themes, states, screenshots, visual diffs, console, page, network, a11y, interactions, trace, reviewed, and verdict fields.

The validators are pure JavaScript and do not claim browser completeness. A schema-valid manifest is only structurally valid; signoff still applies the functional, visual, and a11y gates.

## Artifact boundary

Artifact paths are canonicalized under the caller's workspace, its `output/` directory, or an explicitly supplied `allowedRoot`. Existing symlinks whose targets escape those roots are rejected. Absolute and relative paths are both accepted only after canonical containment checks. PNG diff output is written only when the caller explicitly supplies `diffPath`.

## PNG diff

`png-diff.js` is a zero-dependency PNG provider using Node's built-in zlib. It supports common 8-bit non-interlaced grayscale, RGB, and RGBA PNGs, all PNG row filters, and emits `diffPixels`, `diffRatio`, and exact baseline/actual dimensions. A size mismatch is a hard failure. It is intentionally not a replacement for browser rendering or perceptual review.

## Signoff gates

`frontend_signoff` keeps functional, visual, and a11y results separate. It cannot pass when the manifest is not reviewed, any screenshot or visual diff is unreviewed, console/network errors exist, a critical interaction is not passed, or serious unresolved a11y findings exist. The declared verdict must also be pass for all three dimensions and overall. A pass here means the supplied evidence met these gates; it does not claim live-browser acceptance unless such evidence is explicitly present in the manifest.

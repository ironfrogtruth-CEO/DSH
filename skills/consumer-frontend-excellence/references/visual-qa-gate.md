# Visual QA Gate

## Functional Pass

- Every visible control is exercised with click, keyboard, or touch as applicable.
- Loading, empty, error, success, disabled, and recovery paths are checked.
- Navigation and state persistence work after refresh or thread/page changes.

## Visual Pass

- Inspect initial viewport before scrolling.
- Inspect the densest realistic state and one meaningful post-interaction state.
- Check desktop, compact desktop, and mobile when applicable.
- Check light and dark themes when supported.
- Confirm no critical region is clipped, obscured, off-screen, or dependent on unintended page scrolling.
- Confirm typography, spacing, alignment, radius, border, shadow, icon, and motion decisions follow the same system.
- Confirm long Chinese/English labels, numbers, paths, tables, and code do not break layout.
- Confirm primary action, destructive action, focus state, and status feedback remain perceptible.

## Screenshot Evidence

Capture viewport screenshots for each required theme/viewport/state. Full-page images are secondary debugging evidence. Review screenshots directly; DOM metrics cannot overrule a visible defect.

Signoff fails when:

- any core region is visibly clipped;
- console or page errors remain;
- theme contrast breaks;
- components that mean the same thing look unrelated;
- the intended primary action is not obvious;
- screenshots were captured but not reviewed.

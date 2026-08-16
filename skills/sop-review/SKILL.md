---
name: sop-review
description: Use this skill as the review node in a harness SOP pipeline to summarize completed nodes, artifacts, QA results, failures, rollbacks, reusable patterns, and follow-up improvements after delivery.
---

# SOP Review Node

Use this as node `review`.

## Work

After export or a blocked run, produce a concise retrospective:

- pipeline states
- artifacts created
- QA results
- failures and rollback points
- unresolved evidence gaps
- reusable skills/tools/model selections
- recommended next improvements

## QA Gate

Block if:

- Review overstates validation.
- Local checks are described as user acceptance.
- Remaining risks are hidden.
- Reusable pattern lacks a concrete future trigger.

## Stop Policy

End with current state and next action. Do not restart upstream nodes unless the user asks.

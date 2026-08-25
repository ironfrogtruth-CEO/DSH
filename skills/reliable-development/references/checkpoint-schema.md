# Continuation Checkpoint Schema

Store concise Markdown with these headings:

```markdown
## Objective
## Goal contract and success criteria
## Current pipeline node and confirmed upstream
## User intent and constraints
## Confirmed decisions
## Changed files
## Validation evidence
## Current runtime state
## Remaining work
## Risks and blockers
## Rollback target
## Next action
## Completion standard
```

Rules:

- Preserve exact paths, identifiers, commands, errors, versions, and numeric thresholds.
- Preserve the goal contract across compaction or handoff; do not silently replace the deliverable, success criteria, truth sources, or user constraints.
- Separate completed implementation, focused tests, full regression, live acceptance, and production readiness.
- Keep credentials, tokens, private keys, and full sensitive data out of memory.
- Update by appending a new dated checkpoint; do not erase earlier decisions silently.

# Continuation Checkpoint Schema

Store concise Markdown with these headings:

```markdown
## Objective
## User intent and constraints
## Confirmed decisions
## Changed files
## Validation evidence
## Current runtime state
## Remaining work
## Risks and blockers
## Next action
## Completion standard
```

Rules:

- Preserve exact paths, identifiers, commands, errors, versions, and numeric thresholds.
- Separate completed implementation, focused tests, full regression, live acceptance, and production readiness.
- Keep credentials, tokens, private keys, and full sensitive data out of memory.
- Update by appending a new dated checkpoint; do not erase earlier decisions silently.

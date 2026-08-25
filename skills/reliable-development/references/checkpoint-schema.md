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
## Active runs, jobs, operations, processes, and leases
## Frozen reproduction and preserved artifacts
## Failure class and fingerprint
## Change since last attempt and expected observation
## Remaining work
## Risks and blockers
## Rollback target
## Next action
## Completion standard
```

For retried or resumed work, include this compact lineage block under the relevant headings:

```text
run_id:
parent_run_id:
attempt_id / attempt_index:
node_id:
resume_node_id:
rollback_target:
retry_scope:
failure_fingerprint:
lease_owner / claim_generation:
```

Rules:

- Preserve exact paths, identifiers, commands, errors, versions, and numeric thresholds.
- Preserve the goal contract across compaction or handoff; do not silently replace the deliverable, success criteria, truth sources, or user constraints.
- Separate completed implementation, focused tests, full regression, live acceptance, and production readiness.
- For a failed or retried task, preserve the exact input/version/error and state the retry scope. An empty `change since last attempt` means do not retry.
- Record terminal states, cancellation state, lease owner/generation, and active-work count when a runtime control plane is involved.
- Keep credentials, tokens, private keys, and full sensitive data out of memory.
- Update by appending a new dated checkpoint; do not erase earlier decisions silently.

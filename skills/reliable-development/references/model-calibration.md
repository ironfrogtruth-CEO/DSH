# Model Calibration

Use the same engineering gate with different execution widths.

| Route | Read-only concurrency | Mutation width | Check cadence | Compaction posture |
|---|---:|---:|---:|---|
| DeepSeek V4 Pro | Up to 4 independent checks | One owned subsystem | After each coherent patch | Preserve a large recent tail |
| DeepSeek V4 Flash | Up to 2 independent checks | One contract or 1-3 files | After every patch | Checkpoint before long multi-file phases |
| Gemma4 local | Sequential by default | One file or function | Syntax plus focused test immediately | Compact earlier; keep explicit file/test/next-step fields |

Fallback order:

1. Reduce the step size.
2. Replace open-ended reasoning with a deterministic script or schema.
3. Re-read the exact contract and error.
4. Use a subagent only for a bounded independent question.
5. Escalate a user-owned choice; do not ask for discoverable repository facts.

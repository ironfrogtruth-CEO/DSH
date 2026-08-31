# Model Calibration

Use the same engineering gate with different execution widths.

| Route | Read-only concurrency | Mutation width | Check cadence | Compaction posture |
|---|---:|---:|---:|---|
| DeepSeek V4 Pro | Up to 4 independent checks | One owned subsystem | After each coherent patch | Preserve a large recent tail |
| DeepSeek V4 Flash | Up to 2 independent checks | One contract or 1-3 files | After every patch | Checkpoint before long multi-file phases |
| Cloud 智谱 | Up to 2 independent checks | One contract or 1-3 files | After every patch | Checkpoint before long multi-file phases |

Fallback order:

1. Reduce the step size.
2. Replace open-ended reasoning with a deterministic script or schema.
3. Re-read the exact contract and error.
4. Use a subagent only for a bounded independent question.
5. Escalate a user-owned choice; do not ask for discoverable repository facts.

Text work stays on the cloud DeepSeek or 智谱 route. The local conversation picker is intentionally absent. `x/flux2-klein:4b` remains the backend image route and `embeddinggemma:latest` remains the backend retrieval route; neither may be selected for conversational execution or context compression. FLUX, audio/transcription, video/成片, and TTS/STT stay available through backend adapters and the top-level dispatch path; TTS/STT are fixed tool routes through `/Users/marcus/.dsh/bin/dsh-local-ai`, not LLM model entries.

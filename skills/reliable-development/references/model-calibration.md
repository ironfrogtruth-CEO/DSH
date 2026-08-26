# Model Calibration

Use the same engineering gate with different execution widths.

| Route | Read-only concurrency | Mutation width | Check cadence | Compaction posture |
|---|---:|---:|---:|---|
| DeepSeek V4 Pro | Up to 4 independent checks | One owned subsystem | After each coherent patch | Preserve a large recent tail |
| DeepSeek V4 Flash | Up to 2 independent checks | One contract or 1-3 files | After every patch | Checkpoint before long multi-file phases |
| Ollama local (`cybermarcus:latest`, `glm-marcus:latest`, GLM-4.6V-Flash Q4_K_M) | Sequential by default | One file or contract | managed `bash`/`str_replace_editor`, then syntax plus focused test immediately | Compact earlier; keep explicit file/test/next-step fields |

Fallback order:

1. Reduce the step size.
2. Replace open-ended reasoning with a deterministic script or schema.
3. Re-read the exact contract and error.
4. Use a subagent only for a bounded independent question.
5. Escalate a user-owned choice; do not ask for discoverable repository facts.

The local provider lane is automatic when the active route is `ollama-local`: do not treat the local model as a lower quality gate. The picker exposes only `cybermarcus:latest` and `glm-marcus:latest` (GLM-Marcus, text+image, context 32768, max output 4096). `gemma4:26b-a4b-it-qat` remains the backend visual fallback, `x/flux2-klein:4b` remains the backend image route, and `embeddinggemma:latest` remains the backend retrieval route; these specialist models must not be selected for conversational task execution or context compression. FLUX, audio/transcription, video/成片, and TTS/STT stay available through backend adapters and the top-level dispatch path; TTS/STT are fixed tool routes through `/Users/marcus/.dsh/bin/dsh-local-ai`, not LLM model entries.

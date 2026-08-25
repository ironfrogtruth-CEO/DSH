# Evidence-First Failure Recovery

Use this contract when a non-trivial attempt fails, when work touches a live service or durable worker, or when the same task has started to accumulate retries, restarts, or ad-hoc exceptions.

The objective is not to make every failure disappear automatically. It is to preserve the evidence, identify the responsible layer, change the smallest effective variable, and prevent a retry from repeating the same experiment.

## 1. Freeze before the next mutation

Before editing, retrying, restarting, or creating another real run, record a compact recovery snapshot:

- user objective and completion standard;
- protected user changes and dirty files;
- exact input/sample, version, configuration, prompt/schema, and output namespace;
- exact error, failing assertion, node, timestamp, and last successful boundary;
- active processes, runs, jobs, operations, leases, ports, and worker heartbeats when runtime state matters;
- artifacts that must be preserved;
- rollback point and the one next diagnostic action.

Do not use a mutable latest file as the only evidence. Preserve attempts by run ID or attempt ID so later retries cannot overwrite the failure that motivated them.

## 2. Classify the failure before choosing a fix

Choose one primary class. Record secondary contributors separately.

| Class | Meaning | Default next action |
|---|---|---|
| `CODE_DEFECT` | implementation contradicts an established contract | reproduce with a focused test, patch the responsible code |
| `CONTRACT_MISMATCH` | producer and consumer disagree on fields, semantics, ownership, or capacity | repair the earliest incorrect contract or adapter |
| `QA_PROTOCOL_FAILED` | truncated/malformed/missing evaluator response, schema parse failure, or unavailable QA input | retry only the QA call or batch after repairing its protocol |
| `QUALITY_GATE_FAILED` | valid QA evidence proves the artifact is not acceptable | repair the artifact at the responsible node; do not weaken the gate |
| `DATA_INPUT_GAP` | required truth source or material is absent or not ready | obtain/parse the input or stop for a user-owned decision |
| `MODEL_BEHAVIOR` | nondeterministic or capability-limited model output after the contract is valid | reduce batch size, constrain schema, retry the failed batch, or change route |
| `ENVIRONMENT_RUNTIME` | process, dependency, port, architecture, network, or provider state is wrong | repair environment and verify health before rerunning business work |
| `CONTROL_PLANE_STATE` | duplicate work, stale lease, cancellation failure, ghost run, or terminal-state regression | stop new work and repair ownership/state invariants first |

Do not label every exception as a quality failure. A broken QA response is not proof that the artifact is bad. Conversely, a valid quality failure must not be relabeled as a protocol problem to bypass it.

## 3. Fingerprint the failed experiment

Create a compact fingerprint from the stable parts of the failure:

```text
failure_fingerprint = subsystem + node_or_operation + error_or_issue_code + affected_scope + contract_version
```

Before every retry, state:

```text
change_since_last_attempt:
expected_observation:
retry_scope:
```

When a workflow or durable job is involved, also preserve retry lineage: `run_id`, `parent_run_id`, `attempt_id/index`, `node_id`, `resume_node_id`, `rollback_target`, `lease_owner`, and `claim_generation`.

If `change_since_last_attempt` is empty, do not retry. Observe, inspect, or re-plan instead.

One diagnosed retry of the same fingerprint is normally enough. If the same fingerprint returns again, stop the loop, preserve a diagnostic package, and choose a different route. A different error after a real change gets a new fingerprint and a fresh diagnosis.

## 4. Retry from the last responsible boundary

- Preserve confirmed upstream artifacts and immutable truth sources.
- Restart at the earliest node affected by the change, not at the beginning of the workflow.
- For one-page, one-batch, one-record, or one-component failures, repair and validate that unit before aggregating.
- A QA protocol failure retries the evaluator, not the artifact generator.
- An asset failure returns to the asset owner.
- A content-to-component mapping failure returns to the page/layout contract owner.
- A control-plane failure blocks new business runs until state ownership is correct.

Automatic retry is allowed only when the retry can plausibly change the outcome. Repeating a deterministic failure with identical inputs is not recovery.

## 5. Live-system mutation fence

When a service, durable worker, scheduler, database queue, or user-visible task is active:

1. Read live state before editing.
2. Decide whether current work must finish, be cooperatively cancelled, or be isolated.
3. Do not patch production code and use new real runs as the primary test loop.
4. Prefer a frozen replay, fixture, temporary database, or focused harness.
5. Batch host changes into one planned restart after local checks.
6. After restart, verify ownership and state before submitting work.

For control-plane code, verify these invariants explicitly:

- stable idempotency: a timeout does not create duplicate work;
- single active owner or an explicit, visible concurrency policy;
- monotonic terminal states: `done/failed/stopped/cancelled` cannot return to `running`;
- cancellation propagation across run, operation, job, worker, and external call;
- lease heartbeat plus fencing/claim generation so a stale worker cannot write;
- attempt-scoped artifacts and append-only failure evidence.

## 6. Protect the quality floor

Do not make a failing sample pass by globally lowering a threshold, turning fact loss into a warning, skipping a gate by node-name guessing, or increasing a provider default for every caller.

If a rule is wrong, prove it with a focused counterexample and change the smallest contract that owns it. If a fallback changes the artifact, make the fallback explicit, bounded, and independently validated.

## 7. Verification and reporting

Report each layer separately:

1. frozen reproduction;
2. deterministic/focused test;
3. affected regression surface;
4. restart or runtime-state verification;
5. resumed-node or partial real run;
6. final artifact QA;
7. live user-flow acceptance;
8. production readiness.

Passing a later layer does not erase missing evidence from an earlier one. Completion requires the layers named in the task's acceptance contract, not merely the last command returning zero.

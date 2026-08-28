---
name: plan-before-action
description: 谋定后动：Use when a complex task needs an executable production blueprint, durable node receipts, repeatability assessment, catch-shrimp design, or an authorized run of an existing shrimp. Do not use for trivial one-step answers.
---

# 谋定后动

This is the third CyberMarcus axis. Compile intent into a validated production blueprint before mutation or external execution. It extends the existing seven-node SOP; it does not create another state machine.

## Route

Classify the task as one of:

- `one_off_complex`: build a task blueprint and execute through SOP.
- `catch_candidate`: the outcome, inputs and acceptance are stable enough to become a repeatable versioned Workflow.
- `existing_shrimp`: a published shrimp matches the work contract and complete run inputs are available.
- `shrimp_mismatch`: an existing shrimp cannot satisfy the work contract; return to catch design or draft editing.

Simple tasks stay direct. A suggestion to catch or match a shrimp never authorizes creation, trial, publication or execution.

## Build the Work Contract

Create `cybermarcus_work_contract.v1` with:

1. `goal_contract`: problem, audience action, deliverables and minimum deliverable.
2. `source_contract`: truth sources, derived outputs, debug notes, pollution risks and knowledge versions.
3. `output_contract`: explicit user-facing format and content constraints.
4. `production_blueprint`: task mode and executable nodes.
5. `qa_contract`: node Gates, final acceptance and release conditions.
6. `recovery_contract`: rollback points, retry limit and stable failure-fingerprint fields.
7. `lineage`: durable IDs and checksums as they become available.

For persisted or machine-consumed contracts, read [the work-contract schema](references/cybermarcus_work_contract.v1.schema.json) and validate with `scripts/validate_contract.py`.

## Compile the Blueprint

Every node declares:

- `node_id`, goal and dependencies;
- inputs and outputs;
- source references;
- actual skill/tool/model candidates or deterministic execution unit;
- artifact contract;
- QA Gate and rollback target.

Use agents only for independent judgment under incomplete information. Keep deterministic parsing, schema checks, rendering, export and other fixed operations as tools or validation nodes.

## Execute or Hand Off

- One-off work executes from the confirmed blueprint.
- Catch work hands the same contract to the catch draft, preserving its checksum and projecting legacy goal/acceptance fields for compatibility.
- A shrimp run locks the work-contract checksum, pipeline version, knowledge versions, input snapshot and capability bindings in run lineage.
- Conversational progress never overrides the ShrimpTank run state. Completion comes from runtime receipts and the delivery manifest.

## Receipts and Failure Handling

Each completed node emits `production_receipt.v1`; read [the receipt schema](references/production_receipt.v1.schema.json) when persisting or validating one.

Use a failure fingerprint that includes the responsible subsystem/node, input or contract checksum, workflow/capability version, provider/model when relevant, error code and affected artifact checksum. Retry only after recording a meaningful change. If the same fingerprint recurs after one diagnostic retry, stop and re-plan from the responsible structure node.

## Done Gate

Do not declare completion until the goal/output contracts are read back, required node receipts exist, QA passed, and final lineage reaches a delivery manifest or an explicitly limited minimum deliverable. Separate implementation, focused tests, broader regression, real UI/live acceptance and production readiness.

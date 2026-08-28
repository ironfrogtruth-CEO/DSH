#!/usr/bin/env python3
"""Validate required invariants of CyberMarcus work contracts and receipts."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


class ContractError(ValueError):
    pass


def _object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"{path} must be an object")
    return value


def _nonempty(value: Any, path: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ContractError(f"{path} must not be empty")
    return text


def _list(value: Any, path: str, *, nonempty: bool = False) -> list[Any]:
    if not isinstance(value, list):
        raise ContractError(f"{path} must be an array")
    if nonempty and not value:
        raise ContractError(f"{path} must not be empty")
    return value


def validate_work_contract(value: Any) -> dict[str, Any]:
    root = _object(value, "$")
    if root.get("schema") != "cybermarcus_work_contract.v1":
        raise ContractError("$.schema must be cybermarcus_work_contract.v1")
    required = (
        "goal_contract",
        "source_contract",
        "output_contract",
        "production_blueprint",
        "qa_contract",
        "recovery_contract",
        "lineage",
    )
    for key in required:
        _object(root.get(key), f"$.{key}")
    goal = root["goal_contract"]
    _nonempty(goal.get("problem"), "$.goal_contract.problem")
    _nonempty(goal.get("audience_action"), "$.goal_contract.audience_action")
    _list(goal.get("deliverables"), "$.goal_contract.deliverables", nonempty=True)
    _nonempty(goal.get("minimum_deliverable"), "$.goal_contract.minimum_deliverable")
    source = root["source_contract"]
    for key in ("truth_sources", "derived_outputs", "debug_notes", "pollution_risks", "knowledge_versions"):
        _list(source.get(key), f"$.source_contract.{key}")
    blueprint = root["production_blueprint"]
    mode = blueprint.get("task_mode")
    modes = {"one_off_complex", "catch_candidate", "existing_shrimp", "shrimp_mismatch"}
    if mode not in modes:
        raise ContractError(f"$.production_blueprint.task_mode must be one of {sorted(modes)}")
    nodes = _list(blueprint.get("nodes"), "$.production_blueprint.nodes", nonempty=True)
    ids: set[str] = set()
    for index, raw_node in enumerate(nodes):
        node = _object(raw_node, f"$.production_blueprint.nodes[{index}]")
        node_id = _nonempty(node.get("node_id"), f"$.production_blueprint.nodes[{index}].node_id")
        if node_id in ids:
            raise ContractError(f"duplicate node_id: {node_id}")
        ids.add(node_id)
        _nonempty(node.get("goal"), f"$.production_blueprint.nodes[{index}].goal")
        _list(node.get("dependencies"), f"$.production_blueprint.nodes[{index}].dependencies")
        _list(node.get("inputs"), f"$.production_blueprint.nodes[{index}].inputs")
        _list(node.get("outputs"), f"$.production_blueprint.nodes[{index}].outputs", nonempty=True)
        _object(node.get("qa_gate"), f"$.production_blueprint.nodes[{index}].qa_gate")
        if "rollback_to" not in node:
            raise ContractError(f"$.production_blueprint.nodes[{index}].rollback_to is required")
    for node in nodes:
        missing = [dep for dep in node["dependencies"] if str(dep) not in ids]
        if missing:
            raise ContractError(f"node {node['node_id']} has missing dependencies: {missing}")
    recovery = root["recovery_contract"]
    _list(recovery.get("rollback_points"), "$.recovery_contract.rollback_points", nonempty=True)
    retries = recovery.get("max_retries")
    if not isinstance(retries, int) or retries < 0:
        raise ContractError("$.recovery_contract.max_retries must be a non-negative integer")
    _list(
        recovery.get("failure_fingerprint_fields"),
        "$.recovery_contract.failure_fingerprint_fields",
        nonempty=True,
    )
    return {"schema": root["schema"], "task_mode": mode, "nodes": len(nodes)}


def validate_receipt(value: Any) -> dict[str, Any]:
    root = _object(value, "$")
    if root.get("schema") != "production_receipt.v1":
        raise ContractError("$.schema must be production_receipt.v1")
    _nonempty(root.get("node_id"), "$.node_id")
    if root.get("status") not in {"completed", "blocked", "failed", "rolled_back"}:
        raise ContractError("$.status is invalid")
    _nonempty(root.get("input_checksum"), "$.input_checksum")
    for key in ("version_refs", "actual_bindings", "qa_result"):
        _object(root.get(key), f"$.{key}")
    for key in ("artifacts", "evidence"):
        _list(root.get(key), f"$.{key}")
    qa_status = root["qa_result"].get("status")
    if qa_status not in {"passed", "failed", "blocked"}:
        raise ContractError("$.qa_result.status is invalid")
    _list(root["qa_result"].get("checks"), "$.qa_result.checks")
    if root["status"] == "completed":
        if qa_status != "passed":
            raise ContractError("completed receipt requires qa_result.status=passed")
        _list(root.get("evidence"), "$.evidence", nonempty=True)
    for key in ("failure_fingerprint", "rollback_to"):
        if key not in root:
            raise ContractError(f"$.{key} is required")
    return {"schema": root["schema"], "node_id": root["node_id"], "status": root["status"]}


def validate(value: Any) -> dict[str, Any]:
    schema = value.get("schema") if isinstance(value, dict) else None
    if schema == "cybermarcus_work_contract.v1":
        return validate_work_contract(value)
    if schema == "production_receipt.v1":
        return validate_receipt(value)
    raise ContractError("unsupported or missing schema")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    args = parser.parse_args(argv)
    try:
        value = json.loads(args.path.read_text(encoding="utf-8"))
        summary = validate(value)
    except (OSError, json.JSONDecodeError, ContractError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 2
    print(json.dumps({"ok": True, "summary": summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

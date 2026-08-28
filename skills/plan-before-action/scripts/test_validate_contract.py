#!/usr/bin/env python3
from __future__ import annotations

import unittest

from validate_contract import ContractError, validate_receipt, validate_work_contract


def work_contract() -> dict:
    return {
        "schema": "cybermarcus_work_contract.v1",
        "goal_contract": {
            "problem": "稳定生产周报",
            "audience_action": "管理者据此安排下周动作",
            "deliverables": ["weekly.md"],
            "minimum_deliverable": "有来源的结论清单",
        },
        "source_contract": {
            "truth_sources": ["user-files"],
            "derived_outputs": [],
            "debug_notes": [],
            "pollution_risks": [],
            "knowledge_versions": [],
        },
        "output_contract": {"format": "markdown"},
        "production_blueprint": {
            "task_mode": "catch_candidate",
            "nodes": [
                {
                    "node_id": "parse",
                    "goal": "锁定真源",
                    "dependencies": [],
                    "inputs": ["user-files"],
                    "outputs": ["source-map.json"],
                    "qa_gate": {"checks": ["traceable"]},
                    "rollback_to": "route",
                },
                {
                    "node_id": "deliver",
                    "goal": "交付周报",
                    "dependencies": ["parse"],
                    "inputs": ["source-map.json"],
                    "outputs": ["weekly.md"],
                    "qa_gate": {"checks": ["facts"]},
                    "rollback_to": "parse",
                },
            ],
        },
        "qa_contract": {"node_gates": [], "final_acceptance": [], "release_conditions": []},
        "recovery_contract": {
            "rollback_points": ["parse"],
            "max_retries": 1,
            "failure_fingerprint_fields": ["node", "input_checksum", "error_code"],
        },
        "lineage": {"session_id": "test"},
    }


class ContractValidationTest(unittest.TestCase):
    def test_valid_contract(self) -> None:
        self.assertEqual(validate_work_contract(work_contract())["nodes"], 2)

    def test_missing_dependency_blocks(self) -> None:
        value = work_contract()
        value["production_blueprint"]["nodes"][1]["dependencies"] = ["missing"]
        with self.assertRaises(ContractError):
            validate_work_contract(value)

    def test_completed_receipt_requires_passed_qa_and_evidence(self) -> None:
        receipt = {
            "schema": "production_receipt.v1",
            "node_id": "deliver",
            "status": "completed",
            "input_checksum": "sha256:test",
            "version_refs": {},
            "actual_bindings": {},
            "artifacts": ["weekly.md"],
            "qa_result": {"status": "passed", "checks": ["facts"]},
            "evidence": ["qa-report.json"],
            "failure_fingerprint": None,
            "rollback_to": None,
        }
        self.assertEqual(validate_receipt(receipt)["status"], "completed")
        receipt["evidence"] = []
        with self.assertRaises(ContractError):
            validate_receipt(receipt)


if __name__ == "__main__":
    unittest.main()

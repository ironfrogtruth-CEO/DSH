#!/usr/bin/env python3
import json
import sys
from pathlib import Path


EXPECTED_SKILLS = [
    "goal-first-control",
    "master-control",
    "sop-orchestrator",
    "sop-route",
    "sop-parse",
    "sop-structure",
    "sop-generate",
    "sop-validate",
    "sop-export",
    "sop-review",
]

REGISTRIES = [
    "node_registry.json",
    "skill_registry.json",
    "tool_registry.json",
    "model_registry.json",
    "failure_taxonomy.json",
    "workflow_profiles.json",
    "artifact_contract_registry.json",
    "runtime_contract_schema.json",
]


def fail(message):
    print(f"[FAIL] {message}")
    raise SystemExit(1)


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"invalid JSON: {path}: {exc}")


def check_frontmatter(skills_root):
    for skill in EXPECTED_SKILLS:
        skill_md = skills_root / skill / "SKILL.md"
        if not skill_md.exists():
            fail(f"missing SKILL.md for {skill}")
        text = skill_md.read_text(encoding="utf-8")
        if not text.startswith("---\n"):
            fail(f"missing frontmatter: {skill_md}")
        parts = text.split("---\n", 2)
        if len(parts) < 3:
            fail(f"unclosed frontmatter: {skill_md}")
        fm = parts[1]
        if f"name: {skill}" not in fm:
            fail(f"frontmatter name mismatch: {skill_md}")
        if "description:" not in fm:
            fail(f"missing description: {skill_md}")


def check_node_registry(ref_dir):
    node_registry = load_json(ref_dir / "node_registry.json")
    nodes = node_registry.get("nodes", [])
    expected_ids = ["route", "parse", "structure", "generate", "validate", "export", "review"]
    got_ids = [node.get("node_id") for node in nodes]
    if got_ids != expected_ids:
        fail(f"node order mismatch: {got_ids}")
    required = set(node_registry.get("node_contract_fields", []))
    for field in [
        "node_id",
        "status",
        "goal",
        "inputs",
        "truth_sources",
        "derived_outputs",
        "debug_notes",
        "pollution_risks",
        "skill_used",
        "tool_candidates",
        "model_candidates",
        "artifacts",
        "qa_gate",
        "stop_policy",
        "rollback_to",
    ]:
        if field not in required:
            fail(f"missing node contract field: {field}")
    runtime_fields = set(node_registry.get("runtime_contract_fields", []))
    for field in [
        "template_id",
        "skill_id",
        "tool_ids",
        "input_mapping",
        "context_mapping",
        "input_schema",
        "output_schema",
        "execution_unit",
        "model_policy",
        "qa_gates",
        "rollback_policy",
        "artifact_contract",
    ]:
        if field not in runtime_fields:
            fail(f"missing runtime contract field: {field}")
    for node in nodes:
        for field in ["skill_id", "outputs", "tool_candidates", "model_candidates", "qa_gate", "rollback_to"]:
            if not node.get(field):
                fail(f"node {node.get('node_id')} missing {field}")
    return node_registry


def check_cross_refs(ref_dir, node_registry):
    skill_registry = load_json(ref_dir / "skill_registry.json")
    tool_registry = load_json(ref_dir / "tool_registry.json")
    model_registry = load_json(ref_dir / "model_registry.json")
    failure_taxonomy = load_json(ref_dir / "failure_taxonomy.json")
    workflow_profiles = load_json(ref_dir / "workflow_profiles.json")
    artifact_contracts = load_json(ref_dir / "artifact_contract_registry.json")
    runtime_schema = load_json(ref_dir / "runtime_contract_schema.json")

    skill_ids = {item.get("skill_id") for item in skill_registry.get("skills", [])}
    tool_ids = {item.get("tool_id") for item in tool_registry.get("tools", [])}
    model_ids = {item.get("model_id") for item in model_registry.get("models", [])}
    skills_root = ref_dir.parent.parent
    portable_root = skills_root.parent

    for item in skill_registry.get("skills", []):
        for field in ["skill_id", "path", "portable_path", "path_kind", "availability", "roles"]:
            if field not in item:
                fail(f"skill registry item missing {field}: {item.get('skill_id')}")
        if item.get("availability") in {"installed_local", "system_skill"}:
            portable_path = portable_root / item["portable_path"]
            if not Path(item["path"]).exists() and not portable_path.exists():
                fail(f"registered skill path missing: {item.get('skill_id')} -> {item.get('path')}")

    for skill in EXPECTED_SKILLS:
        if skill not in skill_ids:
            fail(f"skill not registered: {skill}")

    local_skill_ids = {
        path.parent.name
        for path in skills_root.glob("*/SKILL.md")
    }
    missing_local = sorted(local_skill_ids - skill_ids)
    if missing_local:
        fail(f"installed local skills missing from registry: {missing_local}")

    for node in node_registry.get("nodes", []):
        if node.get("skill_id") not in skill_ids:
            fail(f"node skill not registered: {node.get('skill_id')}")
        for tool in node.get("tool_candidates", []):
            if tool not in tool_ids:
                fail(f"node {node.get('node_id')} references unknown tool: {tool}")
        for model in node.get("model_candidates", []):
            if model not in model_ids:
                fail(f"node {node.get('node_id')} references unknown model: {model}")

    for item in model_registry.get("models", []):
        if not item.get("availability"):
            fail(f"model missing availability: {item.get('model_id')}")
        if item.get("model_id") in {"gpt_5_5", "gpt_5_5_thinking", "image2", "research"}:
            if item.get("availability") == "available_current_session":
                fail(f"future/runtime-dependent model incorrectly marked available: {item.get('model_id')}")

    failure_ids = {item.get("id") for item in failure_taxonomy.get("failure_categories", [])}
    for key in failure_taxonomy.get("rollback_policy", {}):
        if key not in failure_ids:
            fail(f"rollback policy references unknown failure category: {key}")

    profile_ids = {item.get("profile_id") for item in workflow_profiles.get("profiles", [])}
    if "sop_default" not in profile_ids:
        fail("workflow_profiles missing sop_default")
    for profile in workflow_profiles.get("profiles", []):
        if not profile.get("steps"):
            fail(f"workflow profile has no steps: {profile.get('profile_id')}")
        for step in profile.get("steps", []):
            for field in ["step_id", "name", "order", "artifact"]:
                if field not in step:
                    fail(f"workflow profile step missing {field}: {profile.get('profile_id')}")

    if not artifact_contracts.get("contracts"):
        fail("artifact_contract_registry has no contracts")
    for contract in artifact_contracts.get("contracts", []):
        for field in ["contract_id", "applies_to", "intermediate", "final"]:
            if not contract.get(field):
                fail(f"artifact contract missing {field}: {contract.get('contract_id')}")

    runtime_required = set(runtime_schema.get("required_runtime_fields", []))
    node_runtime = set(node_registry.get("runtime_contract_fields", []))
    missing_runtime = sorted(runtime_required - node_runtime)
    if missing_runtime:
        fail(f"runtime schema fields missing from node registry: {missing_runtime}")


def main():
    skills_root = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path.home() / ".codex" / "skills"
    ref_dir = skills_root / "sop-orchestrator" / "references"
    check_frontmatter(skills_root)
    for name in REGISTRIES:
        if not (ref_dir / name).exists():
            fail(f"missing registry: {name}")
    node_registry = check_node_registry(ref_dir)
    check_cross_refs(ref_dir, node_registry)
    print("[OK] SOP skill pack is valid")


if __name__ == "__main__":
    main()

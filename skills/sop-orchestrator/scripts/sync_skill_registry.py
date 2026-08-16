#!/usr/bin/env python3
import json
import re
from pathlib import Path


ROOT = Path.home() / ".codex" / "skills"
REGISTRY = ROOT / "sop-orchestrator" / "references" / "skill_registry.json"


ROLE_RULES = [
    ("goal-first-control", ["default_entrypoint", "goal_first", "orchestration", "skill_routing", "pipeline_state"]),
    ("master-control", ["legacy_entrypoint", "orchestration", "skill_routing", "pipeline_state"]),
    ("sop-", ["sop_node", "pipeline_contract"]),
    ("html-report-editor", ["primary_html_editor", "editable_deck", "html_report", "pdf_export"]),
    ("magazine-editor", ["fixed_canvas", "magazine_report", "editable_html", "pdf_export"]),
    ("review-jianshibao", ["primary_review", "material_review", "work_review", "weekly_monthly_report", "executive_reply"]),
    ("pingan-html-materials", ["domain_html_materials", "editable_slides"]),
    ("pingan-kb-curator", ["domain_knowledge_base", "ocr_ingestion", "source_trace"]),
    ("pingan-asset-curator", ["domain_asset_library", "visual_assets"]),
    ("pingan-work-review", ["domain_work_review", "weekly_monthly_report"]),
    ("imagegen", ["image_generation", "image_editing"]),
    ("pdf", ["pdf_read", "pdf_generate", "pdf_render_review"]),
    ("doc", ["docx"]),
    ("jupyter", ["notebook", "experiments"]),
    ("playwright-interactive", ["persistent_browser_debug", "interactive_browser_qa"]),
    ("playwright", ["browser_qa", "html_render_check"]),
    ("screenshot", ["desktop_screenshot", "visual_evidence"]),
    ("transcribe", ["asr", "transcription"]),
    ("figma-implement-design", ["figma_to_code", "design_implementation"]),
    ("figma", ["figma", "design_context"]),
    ("frontend-slides", ["html_slides", "presentation"]),
    ("ux-visual-designer", ["visual_design", "ui_hierarchy"]),
    ("gh-address-comments", ["github_pr_review_comments"]),
    ("gh-fix-ci", ["github_ci_debug"]),
    ("linear", ["linear_issue_management"]),
    ("notion-meeting-intelligence", ["notion_meeting_prep"]),
    ("notion-research-documentation", ["notion_research_docs"]),
    ("notion-spec-to-implementation", ["notion_spec_implementation"]),
    ("build-things", ["special_task"]),
    ("openai-docs", ["official_openai_docs", "api_current_truth"]),
    ("plugin-creator", ["plugin_creation", "codex_extension"]),
    ("skill-creator", ["skill_creation", "skill_management"]),
    ("skill-installer", ["skill_installation", "skill_management"]),
]


def parse_frontmatter(skill_md):
    text = skill_md.read_text(encoding="utf-8", errors="replace")
    if not text.startswith("---\n"):
        return None
    parts = text.split("---\n", 2)
    if len(parts) < 3:
        return None
    fm = parts[1]
    name_match = re.search(r"^name:\s*[\"']?([^\"'\n]+)[\"']?\s*$", fm, re.MULTILINE)
    desc_match = re.search(r"^description:\s*[\"']?(.+?)[\"']?\s*$", fm, re.MULTILINE)
    return {
        "name": name_match.group(1).strip() if name_match else skill_md.parent.name,
        "description": desc_match.group(1).strip() if desc_match else "",
    }


def infer_roles(skill_id, description):
    roles = []
    for prefix, rule_roles in ROLE_RULES:
        if skill_id == prefix or skill_id.startswith(prefix):
            roles.extend(rule_roles)
    text = f"{skill_id} {description}".lower()
    keyword_roles = [
        ("html", "html"),
        ("ppt", "presentation"),
        ("presentation", "presentation"),
        ("pdf", "pdf"),
        ("image", "image"),
        ("figma", "figma"),
        ("github", "github"),
        ("notion", "notion"),
        ("linear", "linear"),
        ("browser", "browser"),
        ("audio", "audio"),
        ("transcribe", "audio"),
        ("review", "review"),
        ("qa", "qa"),
        ("skill", "skill_management"),
    ]
    for keyword, role in keyword_roles:
        if keyword in text:
            roles.append(role)
    if not roles:
        roles.append("general")
    return sorted(set(roles))


def selection_priority(skill_id):
    if skill_id == "goal-first-control":
        return 0
    if skill_id == "master-control":
        return 1
    if skill_id == "sop-orchestrator":
        return 5
    if skill_id.startswith("sop-"):
        return 10
    if skill_id in {"review-jianshibao", "html-report-editor", "magazine-editor"}:
        return 20
    if skill_id.startswith("pingan-"):
        return 40
    return 60


def main():
    skills = []
    for skill_md in sorted(ROOT.glob("*/SKILL.md")):
        skill_id = skill_md.parent.name
        meta = parse_frontmatter(skill_md)
        if not meta:
            continue
        skills.append({
            "skill_id": skill_id,
            "name": meta["name"],
            "path": str(skill_md.parent),
            "portable_path": f"skills/{skill_id}",
            "path_kind": "local_absolute_with_portable_fallback",
            "availability": "installed_local",
            "selection_priority": selection_priority(skill_id),
            "roles": infer_roles(skill_id, meta["description"]),
            "description": meta["description"]
        })

    existing_ids = {item["skill_id"] for item in skills}
    system_root = ROOT / ".system"
    if system_root.exists():
        for skill_md in sorted(system_root.glob("*/SKILL.md")):
            meta = parse_frontmatter(skill_md)
            if not meta:
                continue
            skill_id = meta["name"]
            if skill_id in existing_ids:
                continue
            skills.append({
                "skill_id": skill_id,
                "name": meta["name"],
                "path": str(skill_md.parent),
                "portable_path": f"skills/.system/{skill_md.parent.name}",
                "path_kind": "system_absolute_optional",
                "availability": "system_skill",
                "selection_priority": 30,
                "roles": infer_roles(skill_id, meta["description"]),
                "description": meta["description"]
            })

    skills = sorted(skills, key=lambda item: (item["selection_priority"], item["skill_id"]))
    data = {
        "schema_version": "1.1.0",
        "registry_policy": "Registry-backed skill selection. Master-control may orchestrate any installed skill, but must select the workflow-fit skill by goal, artifact, source-truth, format, and validation needs.",
        "selection_policy_ref": "skill_selection_policy.md",
        "skills": skills,
    }
    REGISTRY.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[OK] wrote {REGISTRY} with {len(skills)} skills")


if __name__ == "__main__":
    main()

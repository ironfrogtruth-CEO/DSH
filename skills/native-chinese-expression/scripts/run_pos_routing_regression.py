#!/usr/bin/env python3
"""Validate all 5 carrier × 6 audience × 6 clause-role routes."""

from __future__ import annotations

import json
import sys

from resolve_expression_profile import load_profiles, resolve_profile


def run() -> dict:
    data = load_profiles()
    carriers = list(data["carriers"])
    audiences = list(data["audiences"])
    roles = list(data["clause_roles"])
    failures = []
    total = 0

    for carrier in carriers:
        for audience in audiences:
            for role in roles:
                total += 1
                profile = resolve_profile(carrier, audience, role)
                reasons = []
                if profile["profile_type"] != "qualitative_not_ratio":
                    reasons.append("profile_type")
                if not profile["facts_override_profile"]:
                    reasons.append("facts_override_profile")
                if len(profile["prioritize"]) < 2:
                    reasons.append("prioritize")
                if not profile["skeletons"]:
                    reasons.append("skeletons")
                if role == "evidence_data" and not {"numeral", "classifier", "noun", "verb"}.issubset(profile["prioritize"]):
                    reasons.append("evidence_data_core")
                if role == "action" and not {"noun", "verb", "adverb"}.issubset(profile["prioritize"]):
                    reasons.append("action_core")
                if carrier in {"data_analysis_report", "enterprise_health_report"} and any(
                    item in profile["prioritize"] for item in ("interjection", "onomatopoeia")
                ):
                    reasons.append("formal_register")
                if reasons:
                    failures.append({
                        "carrier": carrier,
                        "audience": audience,
                        "clause_role": role,
                        "reasons": reasons,
                    })

    expected = 5 * 6 * 6
    return {
        "skill_id": "native-chinese-expression",
        "contract_version": data["contract_version"],
        "matrix": {"carriers": len(carriers), "audiences": len(audiences), "clause_roles": len(roles)},
        "total": total,
        "passed": total - len(failures),
        "failed": len(failures),
        "success": total == expected and not failures,
        "failures": failures,
    }


if __name__ == "__main__":
    report = run()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report["success"] else 1)

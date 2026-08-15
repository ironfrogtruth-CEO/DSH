#!/usr/bin/env python3
"""Run 120 deterministic contract cases across twelve Chinese artifact routes."""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass

from lint_chinese_expression import lint


@dataclass
class Case:
    case_id: str
    category: str
    text: str
    artifact_type: str = "other"
    source: str | None = None
    protected: tuple[str, ...] = ()
    strict: bool = False
    expected: str = "pass"
    expected_rule: str | None = None


TOPICS = ["预约流程", "复查名单", "岗位风险", "服务记录", "预算口径", "员工反馈", "数据来源", "客户需求", "页面结论", "交付状态"]


def make_cases() -> list[Case]:
    cases: list[Case] = []

    for i, topic in enumerate(TOPICS):
        good = i < 5
        cases.append(Case(
            f"chat-{i + 1:02d}", "简短聊天回复",
            f"我先核对{topic}，确认后告诉你下一步怎么处理。" if good else f"基于对{topic}的分析，实现服务方案的优化。",
            "chat", expected="pass" if good else "warn",
            expected_rule=None if good else "STYLE_TRANSLATIONESE_FRAME",
        ))

    for i, topic in enumerate(TOPICS):
        good = i < 5
        cases.append(Case(
            f"task-{i + 1:02d}", "复杂任务说明",
            f"先确认{topic}，再完成实施和验收；如果检查失败，就回到上一步修正。" if good else f"围绕{topic}，开展能力提升工作。",
            "proposal", expected="pass" if good else "warn",
            expected_rule=None if good else "STYLE_TRANSLATIONESE_FRAME",
        ))

    for i, topic in enumerate(TOPICS):
        number = 12 + i
        source = f"本周完成{number}项{topic}检查，仍有2项等待确认。"
        candidate = source if i < 5 else f"本周完成{number + 3}项{topic}检查，仍有2项等待确认。"
        cases.append(Case(
            f"summary-{i + 1:02d}", "报告摘要", candidate, "report", source=source,
            expected="pass" if i < 5 else "blocker",
            expected_rule=None if i < 5 else "FACT_NUMERIC_DRIFT",
        ))

    for i, topic in enumerate(TOPICS):
        good = i < 5
        cases.append(Case(
            f"action-{i + 1:02d}", "建议与行动计划",
            f"由项目负责人核对{topic}，本周五前提交结果并记录未解决问题。" if good else f"推动{topic}体系化提升。",
            "proposal", expected="pass" if good else "warn",
            expected_rule=None if good else "STYLE_SHELL_VERB",
        ))

    title_topics = ["岗位风险", "服务使用", "员工复查", "客户续约", "预算安排", "健康管理", "服务方案", "风险问题", "使用情况", "下一步工作"]
    for i, topic in enumerate(title_topics):
        good = i < 5
        cases.append(Case(
            f"ppt-title-{i + 1:02d}", "PPT结论型标题",
            f"{topic}已经明确，下一步应优先处理高风险人群" if good else f"{topic}现状分析",
            "page_title", strict=True, expected="pass" if good else "blocker",
            expected_rule=None if good else "TITLE_NOT_CLOSED",
        ))

    nav_topics = ["员工概况", "健康风险", "服务使用", "费用分析", "下一步建议", "岗位管理", "复查安排", "客户服务", "年度计划", "项目总结"]
    for i, topic in enumerate(nav_topics):
        good = i < 5
        cases.append(Case(
            f"nav-{i + 1:02d}", "目录和导航标题",
            topic if good else f"全面提升{topic}",
            "ppt", expected="pass" if good else "warn",
            expected_rule=None if good else "STYLE_VAGUE_MODIFIER",
        ))

    for i, topic in enumerate(TOPICS):
        number = 30 + i
        source = f"{topic}覆盖{number}人，占本次样本的20%。"
        candidate = source if i < 5 else f"{topic}覆盖{number}人，占本次样本的35%。"
        cases.append(Case(
            f"data-{i + 1:02d}", "数据解释", candidate, "research", source=source,
            expected="pass" if i < 5 else "blocker",
            expected_rule=None if i < 5 else "FACT_NUMERIC_DRIFT",
        ))

    for i, topic in enumerate(TOPICS):
        source = f"{topic}样本不足，Gate失败，本轮仅作为观察。"
        candidate = source if i < 5 else f"{topic}样本已经足够，Gate通过，可以正式推荐。"
        cases.append(Case(
            f"research-{i + 1:02d}", "研究限制与风险提示", candidate, "research", source=source,
            protected=("Gate失败", "仅作为观察"),
            expected="pass" if i < 5 else "blocker",
            expected_rule=None if i < 5 else "FACT_PROTECTED_TERM_MISSING",
        ))

    for i, topic in enumerate(TOPICS):
        good = i < 5
        cases.append(Case(
            f"product-{i + 1:02d}", "产品与服务介绍",
            f"完成{topic}后，用户可以查看结果并决定是否继续。" if good else f"全面提升{topic}的确定性提升。",
            "product_copy", expected="pass" if good else "warn",
            expected_rule=None if good else "STYLE_VAGUE_MODIFIER",
        ))

    for i, topic in enumerate(TOPICS):
        good = i < 5
        cases.append(Case(
            f"system-{i + 1:02d}", "系统提示和错误信息",
            f"{topic}尚未保存。请检查必填项后再次提交。" if good else f"基于{topic}异常，实现重试。",
            "system_message", expected="pass" if good else "warn",
            expected_rule=None if good else "STYLE_TRANSLATIONESE_FRAME",
        ))

    for i, topic in enumerate(TOPICS):
        source = f"基于对{topic}的分析，实现3项工作优化。"
        candidate = f"分析{topic}后，再调整3项工作。" if i < 5 else source
        cases.append(Case(
            f"translation-{i + 1:02d}", "翻译腔改写", candidate, "other", source=source,
            expected="pass" if i < 5 else "warn",
            expected_rule=None if i < 5 else "STYLE_TRANSLATIONESE_FRAME",
        ))

    for i, topic in enumerate(TOPICS):
        source = f"{topic}由A07确认，状态为待审核，计划于2026年8月完成。"
        candidate = source if i < 5 else f"{topic}已经确认，计划于2026年8月完成。"
        cases.append(Case(
            f"locked-{i + 1:02d}", "已锁定正式文本", candidate, "report", source=source,
            protected=("A07", "状态为待审核"),
            expected="pass" if i < 5 else "blocker",
            expected_rule=None if i < 5 else "FACT_PROTECTED_TERM_MISSING",
        ))

    return cases


def run() -> dict:
    cases = make_cases()
    failures = []
    category_counts: dict[str, int] = {}
    for case in cases:
        category_counts[case.category] = category_counts.get(case.category, 0) + 1
        result = lint(case.text, case.artifact_type, case.source, list(case.protected), case.strict)
        rules = {item["rule_id"] for item in result["issues"]}
        blockers = result["counts"]["blocker"]
        warnings = result["counts"]["warning"]
        matched = (
            (case.expected == "pass" and blockers == 0 and warnings == 0)
            or (case.expected == "warn" and blockers == 0 and warnings > 0)
            or (case.expected == "blocker" and blockers > 0)
        )
        if case.expected_rule and case.expected_rule not in rules:
            matched = False
        if not matched:
            failures.append({
                "case_id": case.case_id,
                "category": case.category,
                "expected": case.expected,
                "expected_rule": case.expected_rule,
                "actual": result,
            })

    return {
        "skill_id": "native-chinese-expression",
        "contract_version": "1.1.0",
        "total": len(cases),
        "categories": len(category_counts),
        "cases_per_category": category_counts,
        "passed": len(cases) - len(failures),
        "failed": len(failures),
        "success": not failures and len(cases) == 120 and len(category_counts) == 12,
        "failures": failures,
    }


if __name__ == "__main__":
    report = run()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report["success"] else 1)

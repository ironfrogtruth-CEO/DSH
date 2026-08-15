#!/usr/bin/env python3
"""Conservative Chinese-expression linter and fact-preservation helper."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path

VERSION = "1.1.0"

EMPTY_TERMS = {
    "赋能": "说明具体提供了什么帮助",
    "抓手": "改成具体工具、动作或责任人",
    "闭环": "写清开始、跟进和完成条件",
    "价值沉淀": "说明最终留下了什么可复用结果",
    "底层逻辑": "直接写真正的原因或规则",
    "颗粒度": "说明要细到什么层级",
    "强感知": "说明读者具体能感受到什么",
    "确定性提升": "说明哪项结果更稳定，以及依据是什么",
    "全面提升": "说明具体提升哪些指标或能力",
    "高质量": "说明判断质量的具体标准",
}

PREPOSITION_PATTERNS = [
    r"对于[^，。；]{2,24}而言",
    r"基于[^，。；]{2,24}(?:，|进行|实现|开展)",
    r"围绕[^，。；]{2,24}(?:，|进行|开展|构建)",
    r"在[^，。；]{2,18}(?:方面|层面)(?:，|上)",
    r"通过[^，。；]{2,30}实现",
]

SHELL_VERBS = re.compile(r"(?:进行|开展|推动|实现|打造|构建)(?:了|好|起)?(?:对|一套|一个)?[\u4e00-\u9fff]{2,16}(?:工作|建设|提升|优化|管理|体系|机制|能力|发展)")
DECREE_WORDS = re.compile(r"(?:一句话(?:说透|钉死)|真正的关键|本质上|不难发现|值得注意的是|毋庸置疑)")
NUMBER_TOKEN = re.compile(r"(?<![A-Za-z0-9])(?:\d{1,4}(?:[-/.年]\d{1,2}){1,2}|\d+(?:\.\d+)?%?|[A-Z]{1,6}\d{2,})")
SENTENCE_SPLIT = re.compile(r"(?<=[。！？!?；;])")
TITLE_BAD_END = re.compile(r"(?:方面|层面|路径|机制|策略|思考|探索|分析|研究|建设|优化|提升|再|与|及|和|并|从|向|为)[：:]?$" )
NOMINAL_ENDINGS = re.compile(r"[\u4e00-\u9fff]{1,6}(?:性|化|度|体系|机制|路径|能力|水平)")
FUNCTION_WORDS = re.compile(r"基于|围绕|通过|对于|关于|针对|按照|依据|由于|因此|从而|以及|并且|同时|此外")
OVERDRIVE_ADVERBS = re.compile(r"全面|持续|进一步|充分|切实|有效|显著|不断|深入|大力|积极")


def issue(rule_id: str, severity: str, message: str, evidence: str = "", suggestion: str = "") -> dict:
    return {
        "rule_id": rule_id,
        "severity": severity,
        "message": message,
        "evidence": evidence[:160],
        "suggestion": suggestion,
    }


def extract_fact_tokens(text: str) -> list[str]:
    return sorted(NUMBER_TOKEN.findall(text))


def lint(
    text: str,
    artifact_type: str,
    source: str | None,
    protected: list[str],
    strict: bool,
    audience: str = "",
    clause_role: str = "",
) -> dict:
    issues: list[dict] = []

    if source is not None:
        source_tokens = extract_fact_tokens(source)
        candidate_tokens = extract_fact_tokens(text)
        if source_tokens != candidate_tokens:
            issues.append(issue(
                "FACT_NUMERIC_DRIFT",
                "blocker",
                "候选文本中的数字、日期、百分比或代码与原文不一致。",
                f"source={source_tokens}; candidate={candidate_tokens}",
                "回到原文核对，不要自动补写或删除数字。",
            ))

    for term in protected:
        if term and term not in text:
            issues.append(issue(
                "FACT_PROTECTED_TERM_MISSING",
                "blocker",
                "候选文本遗漏了受保护内容。",
                term,
                "恢复受保护内容并重新检查语义。",
            ))

    for term, suggestion in EMPTY_TERMS.items():
        count = text.count(term)
        if count:
            issues.append(issue(
                "STYLE_VAGUE_MODIFIER",
                "warning",
                f"“{term}”出现{count}次，可能没有说明具体标准或动作。",
                term,
                suggestion,
            ))

    for pattern in PREPOSITION_PATTERNS:
        match = re.search(pattern, text)
        if match:
            issues.append(issue(
                "STYLE_TRANSLATIONESE_FRAME",
                "warning",
                "句子可能由介词框架和抽象动作主导。",
                match.group(0),
                "找出真实主体、动作和对象后重新组织句子。",
            ))

    shell_match = SHELL_VERBS.search(text)
    if shell_match:
        issues.append(issue(
            "STYLE_SHELL_VERB",
            "warning",
            "空壳动词后仍接抽象名词，动作不够具体。",
            shell_match.group(0),
            "写清谁具体做什么，以及结果怎样判断。",
        ))

    decree_match = DECREE_WORDS.search(text)
    if decree_match:
        issues.append(issue(
            "STYLE_DECREE_TONE",
            "warning",
            "出现裁决式或模板化强调。",
            decree_match.group(0),
            "直接陈述判断和依据；确需强调时保留。",
        ))

    for sentence in [part for part in re.split(r"[。！？!?；;]", text) if part.strip()]:
        nominal_terms = NOMINAL_ENDINGS.findall(sentence)
        if len(nominal_terms) >= 3:
            issues.append(issue(
                "STYLE_NOMINALIZATION_STACK",
                "warning",
                "同一句中抽象名词较多，可能隐藏了主体和动作。",
                "、".join(nominal_terms),
                "保留必要术语，其余改成谁做什么、结果如何判断。",
            ))
        function_terms = FUNCTION_WORDS.findall(sentence)
        if len(function_terms) >= 4:
            issues.append(issue(
                "STYLE_FUNCTION_WORD_CHAIN",
                "warning",
                "介词或连词连续承担关系，主干可能不清楚。",
                "、".join(function_terms),
                "先写主句，再保留真正需要的原因、条件或转折。",
            ))
        adverb_terms = OVERDRIVE_ADVERBS.findall(sentence)
        if len(adverb_terms) >= 3:
            issues.append(issue(
                "STYLE_ADVERB_OVERDRIVE",
                "warning",
                "程度和推进副词较密，可能用语气代替证据。",
                "、".join(adverb_terms),
                "删除没有指标或事实支撑的程度词。",
            ))

    sentences = [part.strip() for part in SENTENCE_SPLIT.split(text) if part.strip()]
    long_limit = 68 if artifact_type in {"chat", "system_message", "ppt", "page_title"} else 88
    for sentence in sentences:
        visible_len = len(re.sub(r"\s+", "", sentence))
        if visible_len > long_limit:
            issues.append(issue(
                "STYLE_LONG_SENTENCE",
                "warning",
                f"句子长约{visible_len}字，首次阅读可能吃力。",
                sentence,
                "按判断、证据、解释或动作拆分，但不要破坏真实关系。",
            ))

    starts = []
    for sentence in sentences:
        normalized = re.sub(r"^[\s\-•*\d.、（）()]+", "", sentence)
        if len(normalized) >= 4:
            starts.append(normalized[:4])
    repeated = [start for start, count in Counter(starts).items() if count >= 3]
    if repeated:
        issues.append(issue(
            "STYLE_REPEATED_OPENING",
            "warning",
            "多个句子使用相同开头，可能形成机械排比。",
            "、".join(repeated),
            "检查各项是否真正并列；不必为了整齐强行改写。",
        ))

    if artifact_type in {"page_title", "ppt_title"}:
        title = text.strip().rstrip("。！？!?")
        if TITLE_BAD_END.search(title) or re.fullmatch(r"[\u4e00-\u9fffA-Za-z0-9]{2,14}(?:分析|概览|现状|方案|建议|规划)", title):
            issues.append(issue(
                "TITLE_NOT_CLOSED",
                "blocker" if strict else "warning",
                "标题可能只写了主题、过程或悬空名词，没有把本页判断说完。",
                title,
                "改成完整的事实、判断、建议或结果；目录导航标题除外。",
            ))

    blocker_count = sum(item["severity"] == "blocker" for item in issues)
    warning_count = sum(item["severity"] == "warning" for item in issues)
    return {
        "skill_id": "native-chinese-expression",
        "contract_version": VERSION,
        "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "artifact_type": artifact_type,
        "audience": audience,
        "clause_role": clause_role,
        "fact_gate": "fail" if blocker_count else ("pass" if source is not None or protected else "not_run"),
        "expression_gate": "fail" if blocker_count else ("warn" if warning_count else "pass"),
        "pass": blocker_count == 0,
        "counts": {"blocker": blocker_count, "warning": warning_count},
        "issues": issues,
    }


def read_text(value: str | None, path: str | None) -> str | None:
    if value is not None:
        return value
    if path is not None:
        return Path(path).read_text(encoding="utf-8")
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="检查中文表达风险与受保护事实。")
    parser.add_argument("--text", help="待检查文本；未提供时从标准输入读取")
    parser.add_argument("--file", help="待检查UTF-8文本文件")
    parser.add_argument("--source", help="改写前原文")
    parser.add_argument("--source-file", help="改写前UTF-8文本文件")
    parser.add_argument("--artifact-type", default="other")
    parser.add_argument("--audience", default="")
    parser.add_argument("--clause-role", default="")
    parser.add_argument("--protected", action="append", default=[], help="必须保留的文本，可重复")
    parser.add_argument("--strict", action="store_true", help="对标题等路由启用阻断级检查")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    text = read_text(args.text, args.file)
    if text is None:
        text = sys.stdin.read()
    source = read_text(args.source, args.source_file)
    result = lint(text, args.artifact_type, source, args.protected, args.strict, args.audience, args.clause_role)
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0 if result["pass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

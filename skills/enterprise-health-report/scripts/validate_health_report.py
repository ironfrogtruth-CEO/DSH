#!/usr/bin/env python3
from __future__ import annotations

import re
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[4]
COMPONENT_SOURCE_POLICY_PATH = PROJECT_ROOT / "contracts" / "component-source-policy.json"
COMPONENT_SOURCE_POLICY = json.loads(COMPONENT_SOURCE_POLICY_PATH.read_text(encoding="utf-8"))
if (
    COMPONENT_SOURCE_POLICY.get("schemaVersion") != "component-source-policy.v1"
    or not isinstance(COMPONENT_SOURCE_POLICY.get("approvedPrefixes"), list)
    or not COMPONENT_SOURCE_POLICY.get("approvedPrefixes")
    or not isinstance(COMPONENT_SOURCE_POLICY.get("approvedExactWithOptionalFragment"), list)
    or not COMPONENT_SOURCE_POLICY.get("approvedExactWithOptionalFragment")
):
    raise RuntimeError("COMPONENT_SOURCE_POLICY_INVALID")
APPROVED_COMPONENT_SOURCE_PREFIXES = tuple(str(item).strip() for item in COMPONENT_SOURCE_POLICY["approvedPrefixes"] if str(item).strip())
APPROVED_COMPONENT_EXACT_SOURCES = tuple(str(item).strip() for item in COMPONENT_SOURCE_POLICY["approvedExactWithOptionalFragment"] if str(item).strip())


def is_approved_component_source_path(value: object) -> bool:
    source_path = str(value or "").strip()
    if not source_path or "\\" in source_path or ".." in source_path:
        return False
    if source_path.startswith("component-library::manual/"):
        if not re.fullmatch(r"component-library::manual/[A-Za-z0-9._/-]+", source_path):
            return False
    elif not re.fullmatch(r"resources/[A-Za-z0-9._/-]+(?:::[A-Za-z0-9._-]+)?", source_path):
        return False
    if source_path.startswith(APPROVED_COMPONENT_SOURCE_PREFIXES):
        return True
    return any(source_path == exact or source_path.startswith(f"{exact}::") for exact in APPROVED_COMPONENT_EXACT_SOURCES)


BANNED = [
    "为什么要续保",
    "领导可读结论",
    "焦点字段设计",
    "异常成因",
    "进一步风险",
    "缓解动作",
    "服务承接",
    "面向组织管理视角",
    "这份报告先回答",
    "本页用于",
    "各查各的",
    "各管各的",
    "后续三页",
    "到线+到店",
    "必须把这组指标",
    "可以看出",
    "需要注意的是",
    "综合来看",
    "进一步说明",
    "总而言之",
    "由此可见",
    "不难发现",
    "页面展示",
    "下文将",
    "用于判断",
    "用于校验",
    "用于识别",
    "用于支撑",
    "用于说明",
    "字段表派生摘要",
    "字段表结构化证据",
    "derivedInsights",
    "高占比/检出类",
    "服务触达线索",
    "业务数据摘要",
    "数据分析稿",
]

REQUIRED_EDITOR_IDS = [
    "toggleEdit",
    "addImage",
    "setTopImage",
    "setFooterImage",
    "triggerReplace",
    "imageFit",
    "imageOpacity",
    "widgetWidth",
    "widgetHeight",
    "footerTopOpacity",
    "footerBottomOpacity",
]


def fail(message: str) -> tuple[bool, str]:
    return False, message


def pass_(message: str) -> tuple[bool, str]:
    return True, message


def collect_local_resources(path: Path, html: str) -> str:
    bundle = html
    for pattern in [r'<link[^>]+href="([^"]+)"', r'<script[^>]+src="([^"]+)"']:
        for match in re.findall(pattern, html):
            if re.match(r"^(https?:|data:|#)", match):
                continue
            candidate = (path.parent / match).resolve()
            if candidate.exists() and candidate.is_file():
                bundle += "\n" + candidate.read_text(encoding="utf-8", errors="ignore")
    return bundle


def strip_tags(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", value or "")).strip()


def cjk_len(value: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fff]", value or ""))


def metric_value_fits(value: str) -> bool:
    text = strip_tags(value)
    if not text:
        return True
    if re.search(r"[。；;]", text):
        return False
    if re.match(r"^\d+\.\d{2,}$", text):
        return False
    if len(text) > 24:
        return False
    if cjk_len(text) > 12 and not re.search(r"[｜/]", text):
        return False
    if len(re.findall(r"\d+(?:\.\d+)?", text)) > 2 and not re.search(r"[｜/]", text):
        return False
    return True


def validate(html: str) -> list[tuple[bool, str]]:
    pages = sum(1 for value in re.findall(r'class="([^"]+)"', html) if "page" in value.split())
    checks: list[tuple[bool, str]] = []
    is_full_report = 'data-report-mode="full"' in html or "full-report-standard" in html
    is_current_five_part = 'data-standard-boundary="enterprise-health-current-20260803-five-part-v1"' in html
    visible_html = re.sub(r"<script[\s\S]*?</script>", "", html, flags=re.I)
    visible_html = re.sub(r"<style[\s\S]*?</style>", "", visible_html, flags=re.I)

    checks.append(pass_(f"pages={pages}") if pages else fail("未发现 .page 页面"))
    checks.append(
        pass_("A4 fixed canvas 794x1123")
        if "width:794px;height:1123px" in html or ("width:794px" in html and "height:1123px" in html)
        else fail("未发现 794px × 1123px A4 固定画布")
    )
    footer_slots = html.count('data-layer="pageFooter"')
    fixed_template_pages = html.count('data-fixed-template="true"')
    expected_footer_counts = {0} if is_current_five_part else {pages}
    if pages >= 2:
        expected_footer_counts.add(pages - 2)
        expected_footer_counts.add(max(0, pages - 2 - fixed_template_pages))
    expected_footer_counts.add(0)
    checks.append(
        pass_(f"footer slots={footer_slots}")
        if pages and footer_slots in expected_footer_counts
        else fail(f"页脚图片层数量不符合规则：pages={pages}, pageFooter={footer_slots}")
    )
    page_starts = list(re.finditer(r'<section\s+class="page(?:\s|\")', html))
    missing_footer_pages: list[int] = []
    for index, match in enumerate(page_starts):
        end = page_starts[index + 1].start() if index + 1 < len(page_starts) else len(html)
        chunk = html[match.start():end]
        if is_current_five_part or 'data-page-type="cover"' in chunk or 'data-page-type="closing"' in chunk or 'data-fixed-template="true"' in chunk:
            continue
        if 'data-layer="pageFooter"' not in chunk:
            missing_footer_pages.append(index + 1)
    checks.append(
        pass_("现行五部分标准不使用普通页页底背景层" if is_current_five_part else "普通内容页逐页具备页脚图片层")
        if not missing_footer_pages
        else fail(f"普通内容页缺少页脚图片层：pages={missing_footer_pages}")
    )
    checks.append(
        pass_("top image slot size 793x220")
        if "width:793px;height:220px" in html or ("width:793px" in html and "height:220px" in html and "top-image-slot" in html) or (is_current_five_part and "width:794px" in html and "height:220px" in html and "top-image-slot" in html)
        else fail("未发现 793px × 220px 顶部图片层样式")
    )
    checks.append(
        pass_("现行五部分标准已取消页底背景层" if is_current_five_part else "footer slot size 793x300")
        if is_current_five_part or "width:793px;height:300px" in html or ("width:793px" in html and "height:300px" in html and "page-footer-slot" in html)
        else fail("未发现 793px × 300px 页脚图片层样式")
    )
    checks.append(
        pass_("editor toolbar collapsed")
        if "body:not(.edit-mode) .toolbar > *:not(#toggleEdit)" in html
        or "body:not(.edit-mode) .toolbar>*:not(#toggleEdit)" in html
        else fail("未发现编辑器默认收敛开关样式")
    )
    required_editor_ids = ["toggleEdit", "addImage", "setTopImage", "triggerReplace", "imageFit", "imageOpacity", "widgetWidth", "widgetHeight"] if is_current_five_part else REQUIRED_EDITOR_IDS
    missing_ids = [item for item in required_editor_ids if f'id="{item}"' not in html and f"id='{item}'" not in html]
    checks.append(pass_("editor controls present") if not missing_ids else fail("缺少编辑器控件：" + ",".join(missing_ids)))

    found_banned = [word for word in BANNED if word in visible_html]
    checks.append(pass_("banned phrases clear") if not found_banned else fail("发现禁用话术：" + ",".join(found_banned)))
    metric_values = [
        strip_tags(match)
        for match in re.findall(r'class="[^"]*\bmetric-card\b[^"]*"[\s\S]*?<strong[^>]*>([\s\S]*?)</strong>', visible_html)
    ]
    bad_metric_values = [value for value in metric_values if value and not metric_value_fits(value)]
    checks.append(
        pass_("metric card values fit cards")
        if not bad_metric_values
        else fail("指标卡数值过长或像句子，存在溢出风险：" + "、".join(bad_metric_values[:6]))
    )
    signal_values = [
        strip_tags(match)
        for match in re.findall(r'class="[^"]*\bsignal-card-value\b[^"]*"[\s\S]*?>([\s\S]*?)</strong>', visible_html)
    ]
    bad_signal_values = [value for value in signal_values if value and not metric_value_fits(value)]
    checks.append(
        pass_("signal card values fit cards")
        if not bad_signal_values
        else fail("信号卡数值过长或像句子，存在溢出风险：" + "、".join(bad_signal_values[:6]))
    )

    checks.append(
        pass_("free image model present")
        if "image-widget" in html and "free-image" in html
        else fail("未发现可缩放自由图片组件模型 image-widget/free-image")
    )
    checks.append(
        pass_("image replacement pathways present")
        if "function triggerReplacePicker" in html
        and "document.addEventListener('dblclick'" in html
        and "function ensureFileInput" in html
        and "syncTopLayers" in html
        and "syncFooterLayers" in html
        else fail("图片替换能力不完整：需支持双击、工具栏替换、顶图/页脚替换和统一文件选择入口")
    )
    checks.append(
        pass_("image click only selects; movement requires selection box")
        if "else if(!ev.target.closest('.editable-text')" not in html
        and "ev.target.closest('.selection-box')" in html
        else fail("图片或组件点击仍可能直接触发移动，需改为只选中")
    )
    checks.append(
        pass_("snap guide runtime present")
        if "function applySnap" in html and "snap-guide-layer" in html and "SNAP_TOLERANCE" in html
        else fail("未发现拖拽/缩放吸附辅助线能力")
    )
    checks.append(
        pass_("risk wording guard present")
        if any(term in html for term in ["风险分层", "体检异常", "风险口径", "风险提示"])
        else fail("未发现风险图表防误读说明，请检查绿色/红色含义")
    )
    checks.append(
        pass_("notes are placed by current template")
        if (is_current_five_part and ".report-note{position:relative" in html and ".notes{position:absolute" in html)
        or ".concept-note{position:relative" in html
        or "concept-note" in html
        or "footnotes" in html
        else fail("未发现注释组件 concept-note/footnotes")
    )

    if is_full_report:
        cover_match = re.search(r'data-page-type="cover"[\s\S]*?toc-page', html)
        cover_html = cover_match.group(0) if cover_match else ""
        toc_match = re.search(r'<section class="page toc-page[\s\S]*?data-standard-page="p03"', html)
        toc_html = toc_match.group(0) if toc_match else ""
        closing_match = re.search(r'data-page-type="closing"[\s\S]*$', html)
        closing_html = closing_match.group(0) if closing_match else ""
        report_notes = re.findall(r'<section class="report-note[\s\S]*?</section>', html)
        report_note_strong_count = sum(block.count("<strong>") for block in report_notes)
        content_pages = html.count('data-page-type="content"')
        meta_match = re.search(r'<script type="application/json" id="report-production-meta">([\s\S]*?)</script>', html)
        try:
            production_meta = json.loads(meta_match.group(1)) if meta_match else {}
        except Exception:
            production_meta = {}
        policy = production_meta.get("pageCountPolicy") or {}
        actual_total = int(policy.get("actualTotalPageCount") or len(production_meta.get("supportMatrix") or []))
        prompt_spec = production_meta.get("pagePromptSpec") if isinstance(production_meta.get("pagePromptSpec"), dict) else {}
        planned_content = int(prompt_spec.get("pageCount") or 0)
        full_framework = policy.get("policy") == "full-framework"
        component_selection = production_meta.get("componentSelection") if isinstance(production_meta.get("componentSelection"), list) else []
        component_sources_ok = all(is_approved_component_source_path(item.get("sourcePath", "")) for item in component_selection)

        checks.append(
            pass_("annual framework gate follows data support")
            if not full_framework or all(item in html for item in ["企业健康全景及风险趋势", "企业医疗支出及价值分析", "健康管理建议"])
            else fail("六大模块齐全时未保留年度核心框架")
        )
        checks.append(
            pass_(f"annual dynamic page count pages={pages}, content={content_pages}")
            if policy.get("enforcePageCount") is not True
            and policy.get("pageCountMode") == "model-dynamic"
            and planned_content >= 1
            and (not actual_total or pages == actual_total)
            else fail(f"年度报告页数未按模型页面计划生成：pages={pages}, planned_content={planned_content}, actual_total={actual_total}")
        )
        checks.append(
            pass_("production metadata and support matrix present")
            if 'id="report-production-meta"' in html
            and '"workflowVersion":"annual-workflow-v3"' in html
            and '"supportMatrix"' in html
            and '"componentSelectionCount"' in html
            and '"pageCountPolicy"' in html
            else fail("缺少年度生产线元数据、页面支持矩阵或组件绑定计数")
        )
        checks.append(
            pass_("component bindings point to approved local component source paths")
            if component_selection and component_sources_ok
            else fail("组件绑定未追溯到组件库路径")
        )
        copy_spec = production_meta.get("copySpec") if isinstance(production_meta.get("copySpec"), dict) else {}
        copy_review = production_meta.get("copyReview") if isinstance(production_meta.get("copyReview"), dict) else {}
        try:
            copy_rule_count = int(copy_spec.get("ruleCount") or 0)
        except Exception:
            copy_rule_count = 0
        checks.append(
            pass_("copySpec and copyReview hardGate present")
            if copy_spec
            and copy_rule_count >= 6
            and copy_review.get("stage") == "hardGate"
            and copy_review.get("passed") is not False
            else fail(f"缺少文案 copySpec 前置约束或 copyReview hardGate 元数据：ruleCount={copy_rule_count}")
        )
        checks.append(
            pass_("foreword is merged into cover")
            if "preface-card" in cover_html
            and "卷首语" in cover_html
            and 'data-page-type="preface"' not in html
            and not re.search(r"黔山有路|烟火有序|原始数据|制作流程", cover_html)
            else fail("卷首语必须合并进封面，且不得保留独立卷首语页")
        )
        checks.append(
            pass_("cover date string removed")
            if "生成日期" not in cover_html and "cover-date" not in html
            else fail("封面不应显示生成日期字符串")
        )
        checks.append(
            pass_("cover subtitle color is locked")
            if re.search(r"\.cover-subtitle\{[^}]*color:#1f4f8f", html)
            else fail("封面报告副标题颜色未按新版标准设置")
        )
        checks.append(
            pass_("catalog is clean")
            if toc_html and not re.search(r"footnotes|concept-note|report-note|note-label|\*\s*完整报告", toc_html)
            else fail("目录页存在注释、解读框或生产注释")
        )
        checks.append(
            pass_("catalog appendix title is clean")
            if toc_html and not re.search(r"<span[^>]*>附录</span>\s*<b[^>]*>(录|附录)</b>", toc_html)
            else fail("目录页附录标题被截断或重复")
        )
        checks.append(
            pass_("interpretation image is correct")
            if "doctor_reader.jpg" in html and "pa_icon_report_interpret.svg" not in html
            else fail("解读模块未使用正确视觉图片")
        )
        checks.append(
            pass_("interpretation key fields highlighted")
            if (".report-note strong{color:var(--on-soft)" in html or ".report-note strong{color:#9e3710" in html) and report_note_strong_count >= min(3, pages)
            else fail("解读模块重点字段未加粗橙色或数量不足")
        )
        checks.append(
            pass_("interpretation follows content flow and footnotes stay bottom-left")
            if re.search(r"\.report-note\{[^}]*position:relative", html)
            and re.search(r"\.report-page \.content>\.report-note\{[^}]*margin-top:0", html)
            and re.search(r"\.report-page \.content>:nth-last-child\(3\)\{[^}]*margin-bottom:14px", html)
            and re.search(r"\.footnotes\{[^}]*position:absolute[^}]*left:45px[^}]*bottom:34px", html)
            else fail("解读模块未跟随正文流，或注释未固定在页面左下角")
        )
        checks.append(
            pass_("tail absolute positioning is locked")
            if re.search(r"\.tail-page \.tail-thanks\.moveable\{[^}]*position:absolute", html)
            and re.search(r"\.tail-page \.tail-sources\.moveable\{[^}]*position:absolute", html)
            else fail("尾页卡片被 moveable 样式覆盖")
        )
        checks.append(
            pass_("capsules are aligned by flex grid")
            if re.search(r"\.chip-row\{[^}]*display:flex;[^}]*flex-wrap:wrap;[^}]*align-items:center", html)
            else fail("胶囊组件未声明上下沿对齐规则")
        )
        checks.append(
            pass_("signal card values are no-wrap")
            if re.search(r"\.signal-grid strong\{[^}]*white-space:nowrap", html)
            else fail("总览信号卡数值未声明独立行和禁止断行规则")
        )
        checks.append(
            pass_("full renderer keeps page-plan component bindings")
            if 'data-component-type=' in html and 'data-component=' in html
            else fail("生成材料未保留逐页稿组件绑定")
        )
        checks.append(
            pass_("percentages preserve source-locked precision")
            if production_meta.get("percentagePrecisionPolicy") == "source-locked"
            else fail("报告未声明百分比按已登记证据精度锁定")
        )
        checks.append(
            pass_("knowledge and public evidence refs recorded")
            if '"kb::service-map"' in html and '"officialPublicEvidence"' in html
            else fail("服务推荐或公开研究依据未进入生产元数据")
        )
        checks.append(
            pass_("appendix pages are standalone and tail is clean")
            if "安心常伴健康长行" in closing_html
            and "tail-appendix" not in closing_html
            and "service-plan-grid" not in closing_html
            and "four-service-map" not in closing_html
            and 'data-page-type="content"' not in closing_html
            and not re.search(r"resources/|【模版】|\.md|\.xlsx|本地知识库|制作流程", closing_html)
            else fail("附录未独立成页，或尾页混入附录/内部来源")
        )
    return checks


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: validate_health_report.py path/to/report.html", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    html = path.read_text(encoding="utf-8")
    bundle = collect_local_resources(path, html)
    checks = validate(bundle)
    ok = all(item[0] for item in checks)
    for passed, message in checks:
        print(("[x] " if passed else "[ ] ") + message)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

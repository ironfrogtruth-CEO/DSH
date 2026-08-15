from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Sequence
import math
import re

from PIL import Image, ImageDraw, ImageFont


W, H = 1920, 1080
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "outputs" / "专属健康服务监管包_image2"

ORANGE = "#f05a22"
ORANGE_DARK = "#d94d1f"
ORANGE_SOFT = "#fff1e8"
ORANGE_PALE = "#fff8f4"
GREEN = "#1d8153"
GREEN_SOFT = "#e9f5ef"
INK = "#222222"
MUTED = "#6c727a"
LINE = "#ead8cf"
LINE_DARK = "#e5bca9"
SOFT = "#f7f8fa"
PAPER = "#ffffff"

TEXT_REGISTRY: list[str] = []


def font_path(weight: str = "regular") -> str:
    candidates = {
        "bold": [
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/System/Library/Fonts/STHeiti Medium.ttc",
            "/Library/Fonts/Arial Unicode.ttf",
        ],
        "regular": [
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/System/Library/Fonts/STHeiti Light.ttc",
            "/Library/Fonts/Arial Unicode.ttf",
        ],
    }
    for item in candidates.get(weight, candidates["regular"]):
        if Path(item).exists():
            return item
    return "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"


def f(size: int, weight: str = "regular") -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(font_path(weight), size=size, index=0)


def measure(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> tuple[int, int]:
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def add_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    size: int,
    fill: str = INK,
    weight: str = "regular",
    anchor: str | None = None,
    align: str = "left",
    spacing: int = 6,
    max_width: int | None = None,
    line_height: int | None = None,
) -> int:
    if text:
        TEXT_REGISTRY.append(text)
    ft = f(size, weight)
    if max_width is None:
        draw.text(xy, text, font=ft, fill=fill, anchor=anchor)
        return size
    lines = wrap_text(draw, text, ft, max_width)
    lh = line_height or int(size * 1.35)
    x, y = xy
    for idx, line in enumerate(lines):
        lx = x
        if align == "center":
            tw, _ = measure(draw, line, ft)
            lx = x + (max_width - tw) // 2
        elif align == "right":
            tw, _ = measure(draw, line, ft)
            lx = x + max_width - tw
        draw.text((lx, y + idx * lh), line, font=ft, fill=fill)
    return len(lines) * lh


def wrap_text(draw: ImageDraw.ImageDraw, text: str, ft: ImageFont.ImageFont, max_width: int) -> list[str]:
    paragraphs = str(text).split("\n")
    wrapped: list[str] = []
    for para in paragraphs:
        if not para:
            wrapped.append("")
            continue
        line = ""
        for ch in para:
            trial = line + ch
            if measure(draw, trial, ft)[0] <= max_width or not line:
                line = trial
            else:
                wrapped.append(line)
                line = ch
        if line:
            wrapped.append(line)
    return wrapped


def rounded(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    radius: int = 18,
    fill: str = PAPER,
    outline: str | None = LINE,
    width: int = 2,
) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def pill(
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    w: int,
    h: int,
    label: str,
    fill: str = ORANGE,
    text_fill: str = PAPER,
    size: int = 26,
    weight: str = "bold",
) -> None:
    rounded(draw, (x, y, x + w, y + h), radius=h // 2, fill=fill, outline=None)
    tw, th = measure(draw, label, f(size, weight))
    add_text(draw, (x + (w - tw) // 2, y + (h - th) // 2 - 2), label, size, text_fill, weight)


def arrow(draw: ImageDraw.ImageDraw, start: tuple[int, int], end: tuple[int, int], color: str = ORANGE, width: int = 4) -> None:
    x1, y1 = start
    x2, y2 = end
    draw.line((x1, y1, x2, y2), fill=color, width=width)
    angle = math.atan2(y2 - y1, x2 - x1)
    size = 16
    pts = [
        (x2, y2),
        (x2 - size * math.cos(angle - math.pi / 6), y2 - size * math.sin(angle - math.pi / 6)),
        (x2 - size * math.cos(angle + math.pi / 6), y2 - size * math.sin(angle + math.pi / 6)),
    ]
    draw.polygon(pts, fill=color)


def icon(draw: ImageDraw.ImageDraw, kind: str, cx: int, cy: int, r: int = 42, color: str = ORANGE) -> None:
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill="#fff4ee", outline="#ffd4c2", width=2)
    lw = max(4, r // 9)
    if kind == "cross":
        draw.rounded_rectangle((cx - 8, cy - 24, cx + 8, cy + 24), radius=4, fill=color)
        draw.rounded_rectangle((cx - 24, cy - 8, cx + 24, cy + 8), radius=4, fill=color)
    elif kind == "shield":
        pts = [(cx, cy - 28), (cx + 28, cy - 16), (cx + 22, cy + 22), (cx, cy + 34), (cx - 22, cy + 22), (cx - 28, cy - 16)]
        draw.line(pts + [pts[0]], fill=color, width=lw, joint="curve")
        draw.line((cx, cy - 14, cx, cy + 16), fill=color, width=lw)
        draw.line((cx - 14, cy + 2, cx + 14, cy + 2), fill=color, width=lw)
    elif kind == "heart":
        draw.arc((cx - 32, cy - 28, cx + 2, cy + 8), 190, 20, fill=color, width=lw)
        draw.arc((cx - 2, cy - 28, cx + 32, cy + 8), 160, 350, fill=color, width=lw)
        draw.line((cx - 28, cy - 2, cx, cy + 32, cx + 28, cy - 2), fill=color, width=lw)
        draw.line((cx - 30, cy + 2, cx - 12, cy + 2, cx - 4, cy - 10, cx + 8, cy + 16, cx + 16, cy + 2, cx + 30, cy + 2), fill=color, width=lw)
    elif kind == "scan":
        draw.rectangle((cx - 26, cy - 26, cx + 26, cy + 26), outline=color, width=lw)
        draw.line((cx - 34, cy, cx + 34, cy), fill=color, width=lw)
        draw.arc((cx + 8, cy + 8, cx + 42, cy + 42), 220, 320, fill=color, width=lw)
    elif kind == "doc":
        draw.rounded_rectangle((cx - 24, cy - 32, cx + 24, cy + 32), radius=5, outline=color, width=lw)
        for i in range(3):
            draw.line((cx - 12, cy - 12 + i * 15, cx + 14, cy - 12 + i * 15), fill=color, width=lw - 1)
    elif kind == "syringe":
        draw.line((cx - 24, cy + 18, cx + 20, cy - 26), fill=color, width=lw)
        draw.line((cx + 10, cy - 30, cx + 28, cy - 12), fill=color, width=lw)
        draw.line((cx - 32, cy + 26, cx - 18, cy + 12), fill=color, width=lw)
        draw.line((cx - 2, cy - 4, cx + 12, cy + 10), fill=color, width=lw - 1)
    elif kind == "bed":
        draw.line((cx - 34, cy + 18, cx + 34, cy + 18), fill=color, width=lw)
        draw.line((cx - 34, cy - 18, cx - 34, cy + 26), fill=color, width=lw)
        draw.rounded_rectangle((cx - 28, cy - 18, cx - 4, cy + 4), radius=5, outline=color, width=lw)
        draw.line((cx - 2, cy + 2, cx + 34, cy + 2), fill=color, width=lw)
    elif kind == "person":
        draw.ellipse((cx - 13, cy - 30, cx + 13, cy - 4), outline=color, width=lw)
        draw.arc((cx - 32, cy - 6, cx + 32, cy + 44), 200, 340, fill=color, width=lw)
    elif kind == "moon":
        draw.arc((cx - 8, cy - 32, cx + 36, cy + 30), 90, 275, fill=color, width=lw)
        draw.arc((cx - 34, cy - 32, cx + 20, cy + 30), 285, 80, fill=color, width=lw)
        add_text(draw, (cx + 15, cy - 28), "Z", 18, color, "bold")
        add_text(draw, (cx + 30, cy - 8), "Z", 14, color, "bold")
    elif kind == "knife":
        draw.line((cx - 28, cy + 28, cx + 8, cy - 8), fill=color, width=lw)
        draw.polygon([(cx + 6, cy - 10), (cx + 36, cy - 32), (cx + 22, cy + 2)], outline=color, fill=None)
        draw.line((cx - 34, cy + 34, cx - 18, cy + 18), fill=color, width=lw + 2)
    else:
        draw.line((cx - 30, cy, cx - 12, cy, cx - 4, cy - 16, cx + 8, cy + 18, cx + 16, cy, cx + 30, cy), fill=color, width=lw)


def new_slide(page: int, title: str | None = None, subtitle: str | None = None) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(img)
    draw_background(draw)
    if title:
        add_text(draw, (76, 54), title, 42, INK, "bold")
        draw.rounded_rectangle((78, 128, 160, 136), radius=4, fill=ORANGE)
        if subtitle:
            add_text(draw, (178, 116), subtitle, 22, MUTED, "regular")
    add_text(draw, (1620, 56), "平安好医生", 28, ORANGE, "bold")
    add_text(draw, (1760, 1014), f"P{page:02d}", 18, "#b9a49b")
    return img, draw


def draw_background(draw: ImageDraw.ImageDraw) -> None:
    for i in range(0, 260, 8):
        color = (255, 248 + min(i // 18, 7), 244 + min(i // 14, 8))
        draw.line((0, i, W, i), fill=color, width=8)
    draw.ellipse((1470, -120, 2070, 480), outline="#ffe0d2", width=3)
    draw.ellipse((1535, -55, 2005, 415), outline="#ffe9df", width=2)
    draw.rounded_rectangle((1710, 70, 1816, 176), radius=24, fill="#fff0e8", outline="#ffd8c6", width=2)
    draw.rounded_rectangle((1755, 94, 1772, 151), radius=4, fill=ORANGE)
    draw.rounded_rectangle((1736, 114, 1792, 131), radius=4, fill=ORANGE)
    base_y = 1008
    points = []
    for x in range(-30, W + 31, 30):
        y = base_y + int(16 * math.sin(x / 120)) + int(8 * math.sin(x / 47))
        points.append((x, y))
    draw.line(points, fill="#fde7dc", width=3)
    draw.line([(x, y + 24) for x, y in points], fill="#fff1e8", width=2)
    for x in range(70, 330, 42):
        for y in range(900, 1030, 36):
            draw.ellipse((x, y, x + 3, y + 3), fill="#ffe3d6")


def footer_note(draw: ImageDraw.ImageDraw, text: str) -> None:
    add_text(draw, (78, 1018), text, 17, "#8d7b73", "regular")


def section_label(draw: ImageDraw.ImageDraw, x: int, y: int, text: str, w: int | None = None) -> None:
    ft = f(22, "bold")
    tw, _ = measure(draw, text, ft)
    ww = w or tw + 34
    rounded(draw, (x, y, x + ww, y + 42), radius=21, fill="#fff3ec", outline="#ffcbb8", width=2)
    add_text(draw, (x + 17, y + 8), text, 22, ORANGE, "bold")


def draw_flow(draw: ImageDraw.ImageDraw, items: Sequence[str], x: int, y: int, w: int, h: int, icon_kinds: Sequence[str] | None = None) -> None:
    n = len(items)
    gap = 18
    step_w = (w - gap * (n - 1)) // n
    for i, item in enumerate(items):
        sx = x + i * (step_w + gap)
        rounded(draw, (sx, y, sx + step_w, y + h), radius=18, fill=PAPER, outline="#ffd7c7", width=2)
        icon(draw, icon_kinds[i] if icon_kinds else "doc", sx + step_w // 2, y + 50, 33)
        add_text(draw, (sx + 18, y + 96), item, 23, INK, "bold", max_width=step_w - 36, align="center")
        if i < n - 1:
            arrow(draw, (sx + step_w + 4, y + h // 2), (sx + step_w + gap - 4, y + h // 2), ORANGE, 3)


def draw_matrix_cards(
    draw: ImageDraw.ImageDraw,
    cards: Sequence[tuple[str, str, str]],
    x: int,
    y: int,
    w: int,
    h: int,
    cols: int,
    rows: int | None = None,
) -> None:
    rows = rows or math.ceil(len(cards) / cols)
    gap = 22
    cw = (w - gap * (cols - 1)) // cols
    ch = (h - gap * (rows - 1)) // rows
    for idx, (kind, title, body) in enumerate(cards):
        col = idx % cols
        row = idx // cols
        bx = x + col * (cw + gap)
        by = y + row * (ch + gap)
        rounded(draw, (bx, by, bx + cw, by + ch), radius=18, fill=PAPER, outline="#f1cbbd", width=2)
        icon(draw, kind, bx + 62, by + 64, 40)
        add_text(draw, (bx + 118, by + 35), title, 26, INK, "bold", max_width=cw - 140)
        add_text(draw, (bx + 118, by + 83), body, 20, MUTED, "regular", max_width=cw - 140, line_height=30)


def draw_price_table(
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    w: int,
    row_h: int,
    headers: Sequence[str],
    rows: Sequence[Sequence[str]],
    col_fracs: Sequence[float] | None = None,
    font_size: int = 20,
) -> int:
    col_fracs = col_fracs or [1 / len(headers)] * len(headers)
    col_ws = [int(w * frac) for frac in col_fracs]
    col_ws[-1] += w - sum(col_ws)
    total_h = row_h * (len(rows) + 1)
    rounded(draw, (x, y, x + w, y + total_h), radius=16, fill=PAPER, outline="#f0c8b7", width=2)
    draw.rounded_rectangle((x, y, x + w, y + row_h), radius=16, fill=ORANGE)
    draw.rectangle((x, y + row_h // 2, x + w, y + row_h), fill=ORANGE)
    cx = x
    for i, header in enumerate(headers):
        add_text(draw, (cx + 18, y + 15), header, font_size, PAPER, "bold", max_width=col_ws[i] - 36)
        cx += col_ws[i]
    for r, row in enumerate(rows):
        ry = y + row_h * (r + 1)
        if r % 2 == 1:
            draw.rectangle((x + 2, ry, x + w - 2, ry + row_h), fill="#fffaf7")
        cx = x
        for c, cell in enumerate(row):
            add_text(draw, (cx + 18, ry + 12), cell, font_size, INK if c == 0 else MUTED, "bold" if c == 0 else "regular", max_width=col_ws[c] - 36, line_height=28)
            if c:
                draw.line((cx, ry, cx, ry + row_h), fill="#f1dfd7", width=1)
            cx += col_ws[c]
        draw.line((x, ry, x + w, ry), fill="#f1dfd7", width=1)
    return total_h


def cover() -> None:
    img = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(img)
    draw_background(draw)
    add_text(draw, (78, 70), "平安好医生", 34, ORANGE, "bold")
    add_text(draw, (168, 382), "专属健康服务监管包", 72, INK, "bold")
    draw.rounded_rectangle((174, 490, 325, 500), radius=5, fill=ORANGE)
    for cx, cy, rr in [(1450, 540, 190), (1550, 540, 118), (1450, 540, 250)]:
        draw.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), outline="#ffe0d3", width=3)
    icon(draw, "shield", 1450, 540, 82)
    add_text(draw, (1760, 1014), "P01", 18, "#b9a49b")
    save(img, "P01_封面.png")


def p02_overview() -> None:
    img, draw = new_slide(2, "服务总览｜从单点服务到年度闭环", "早筛识别、免疫防护、精力恢复、就医闭环、全程监管")
    rounded(draw, (78, 188, 398, 800), radius=20, fill=PAPER, outline="#ffcdb9", width=2)
    pill(draw, 114, 216, 220, 46, "健康风险画像")
    risks = [("doc", "报告分散", "体检、就医、检测数据未形成连续档案"), ("scan", "筛查断点", "发现异常后复查、转诊和解读不足"), ("heart", "慢病累积", "血压、血糖、血脂和睡眠需要长期管理"), ("moon", "状态波动", "压力、出差、作息变化影响精力恢复")]
    y = 292
    for kind, title, body in risks:
        icon(draw, kind, 150, y + 26, 34)
        add_text(draw, (208, y - 4), title, 24, INK, "bold")
        add_text(draw, (208, y + 33), body, 17, MUTED, max_width=150, line_height=24)
        y += 122
        draw.line((115, y - 35, 360, y - 35), fill="#f7d6c8", width=1)

    add_text(draw, (480, 214), "核心价值", 30, ORANGE, "bold")
    rounded(draw, (480, 268, 1555, 690), radius=24, fill="#fffaf7", outline="#ffd5c4", width=2)
    core = [
        ("scan", "早筛识别", "高端体检、MR/CT、PET-CT、胃肠镜等重点风险识别"),
        ("shield", "免疫防护", "按年龄、接种史、抗体和禁忌评估疫苗组合"),
        ("moon", "精力恢复", "NAD+可选、睡眠、营养、运动和压力支持"),
        ("heart", "心脑代谢", "血压、血糖、血脂、心电和慢病分层管理"),
        ("person", "就医闭环", "号、床、刀、检、陪协同推进，结果回到档案"),
    ]
    box_w = 190
    for i, (kind, title, body) in enumerate(core):
        bx = 520 + i * 203
        rounded(draw, (bx, 322, bx + box_w, 622), radius=18, fill=PAPER, outline="#f2c8b8", width=2)
        icon(draw, kind, bx + box_w // 2, 384, 44)
        add_text(draw, (bx + 20, 442), title, 25, INK, "bold", max_width=box_w - 40, align="center")
        add_text(draw, (bx + 20, 493), body, 18, MUTED, max_width=box_w - 40, line_height=26)
    draw_flow(draw, ["建档", "筛查", "解读", "干预", "转诊", "随访"], 144, 842, 1530, 128, ["doc", "scan", "doc", "heart", "cross", "person"])
    footer_note(draw, "来源：售前视觉规范、PRESALE003/PRESALE008/PRESALE010 服务链路及权益素材。")
    save(img, "P02_总览.png")


def p03_archive_intro() -> None:
    img, draw = new_slide(3, "服务1｜专属健康档案与监管管家", "把数据、报告、风险和服务动作统一到一条年度主线")
    draw_matrix_cards(
        draw,
        [
            ("doc", "健康数据整合", "体检报告、影像检查、用药记录和接种凭证归档。"),
            ("scan", "风险分层评估", "根据指标异常、年龄阶段和既往史形成重点清单。"),
            ("heart", "主动提醒随访", "复查、接种、慢病指标和服务进度持续提醒。"),
            ("person", "监管管家统筹", "服务预约、结果回收、报告解读和转诊协同。"),
        ],
        86,
        205,
        760,
        486,
        cols=2,
        rows=2,
    )
    rounded(draw, (900, 205, 1660, 704), radius=24, fill="#fffaf7", outline="#ffd3c1", width=2)
    section_label(draw, 940, 232, "年度闭环动作")
    draw_flow(draw, ["授权建档", "报告解读", "风险分层", "年度计划", "月度随访"], 942, 310, 660, 150, ["doc", "doc", "scan", "heart", "person"])
    rounded(draw, (940, 515, 1600, 660), radius=18, fill=PAPER, outline="#f0d5ca", width=2)
    add_text(draw, (970, 542), "为什么推荐", 25, ORANGE, "bold")
    add_text(draw, (970, 588), "这类人群健康数据来源多、节奏快，单次体检很难形成持续管理。监管管家用于把“发现问题”转成“有人跟进、有结果回收、有下一步”。", 22, INK, max_width=590, line_height=34)
    draw_flow(draw, ["建档", "筛查", "解读", "干预", "转诊", "随访"], 150, 810, 1500, 128, ["doc", "scan", "doc", "heart", "cross", "person"])
    footer_note(draw, "来源：PRESALE003 会员权益、PRESALE010 15元月卡设计思路、慢病管理链路。")
    save(img, "P03_服务1_健康档案与监管管家.png")


def p04_archive_delivery() -> None:
    img, draw = new_slide(4, "履约及报价｜健康档案与监管管家", "会员制权益作为基础底座，价格来自既有售前材料")
    draw_flow(draw, ["用户授权", "资料上传", "家医解读", "分层建档", "服务提醒", "月度复盘"], 94, 202, 1200, 150, ["person", "doc", "doc", "scan", "heart", "doc"])
    rounded(draw, (92, 410, 705, 860), radius=22, fill="#fffaf7", outline="#ffd5c4", width=2)
    section_label(draw, 130, 438, "履约说明")
    bullets = [
        "档案范围：体检、检查、问诊、用药、疫苗凭证。",
        "服务角色：家庭医生负责解读与提醒，管家负责进度跟进。",
        "闭环要求：每项服务必须有预约状态、结果回收和下一步建议。",
        "异常处理：需要线下就医时进入就医闭环服务。"
    ]
    by = 510
    for b in bullets:
        draw.ellipse((132, by + 10, 142, by + 20), fill=ORANGE)
        add_text(draw, (158, by), b, 23, INK, max_width=485, line_height=34)
        by += 78

    rows = [
        ("个人会员", "188元/年", "家庭医生6项基础权益 + 自选3项"),
        ("家庭会员", "388元/年", "家属共享权益 + 自选5项"),
        ("尊享会员", "1888元/年", "名医、陪诊、住院等升级权益 + 自选7项"),
    ]
    draw_price_table(draw, 770, 430, 825, 92, ["档位", "参考报价", "权益定位"], rows, [0.24, 0.24, 0.52], 22)
    rounded(draw, (770, 745, 1595, 862), radius=18, fill=GREEN_SOFT, outline="#b6dac7", width=2)
    add_text(draw, (805, 773), "组合建议", 24, GREEN, "bold")
    add_text(draw, (805, 814), "以会员底座承接建档、解读和随访，再按风险追加早筛、疫苗、慢病、精力恢复和就医闭环服务。", 21, INK, max_width=735, line_height=32)
    footer_note(draw, "报价来源：PRESALE003 p006-p009 个人/家庭/尊享会员。")
    save(img, "P04_履约报价_健康档案与监管管家.png")


def p05_screening_intro() -> None:
    img, draw = new_slide(5, "服务2｜高端早筛与影像检查", "把重点风险识别从“年度体检”延伸到专项检查和检后复查")
    draw_matrix_cards(
        draw,
        [
            ("doc", "高端体检", "1+X个性化体检，关注八大系统和肿瘤标志物。"),
            ("scan", "胸部CT", "用于肺部风险筛查和体检异常后的专项复查。"),
            ("scan", "MR/CT", "按部位和临床建议选择磁共振或CT检查。"),
            ("scan", "PET-CT", "高阶影像筛查项目，按机构和适应场景确认。"),
            ("doc", "胃肠镜/检查加急", "针对消化道筛查和急需检查场景安排。"),
            ("person", "检后解读", "报告回收、家医解读、异常复查提醒。"),
        ],
        86,
        190,
        1120,
        620,
        cols=3,
        rows=2,
    )
    rounded(draw, (1260, 220, 1650, 775), radius=24, fill="#fffaf7", outline="#ffd3c1", width=2)
    icon(draw, "scan", 1455, 330, 70)
    add_text(draw, (1300, 430), "为什么推荐", 28, ORANGE, "bold", max_width=300, align="center")
    add_text(draw, (1310, 492), "单次体检只能发现线索。专项影像、胃肠镜和检后解读的价值，是把异常指标转为可执行的复查路径，并把结果回流到健康档案。", 24, INK, max_width=300, line_height=38)
    footer_note(draw, "来源：PRESALE002 p011/p015，PRESALE003 p030 高端体检和影像项目。")
    save(img, "P05_服务2_高端早筛与影像检查.png")


def p06_screening_delivery() -> None:
    img, draw = new_slide(6, "履约及报价｜高端早筛与影像检查", "项目价格依城市、机构和检查组合确认，不编造统一价")
    draw_flow(draw, ["需求评估", "机构匹配", "预约检查", "报告回收", "家医解读", "复查提醒"], 94, 196, 1280, 150, ["scan", "cross", "doc", "doc", "person", "heart"])
    rows = [
        ("高端体检", "1+X体检、VIP检区、公立医院互认项目", "按城市/机构确认"),
        ("胸部CT", "肺部重点风险筛查或异常复查", "按机构确认"),
        ("MR/CT", "按部位、设备和机构安排", "按机构确认"),
        ("PET-CT", "高阶影像项目，需适用评估", "按机构确认"),
        ("胃肠镜/检查加急", "普通检查≤3工作日；胃肠镜≤7工作日", "按项目确认"),
        ("检后解读", "报告回收、家医解读、复查建议", "会员权益或按项目确认"),
    ]
    draw_price_table(draw, 112, 430, 1160, 74, ["项目", "履约口径", "报价"], rows, [0.24, 0.52, 0.24], 20)
    rounded(draw, (1325, 420, 1640, 858), radius=22, fill="#fffaf7", outline="#ffd5c4", width=2)
    section_label(draw, 1360, 448, "医学口径")
    add_text(draw, (1362, 520), "早筛和影像检查用于风险识别与复查管理，不替代医生诊断。具体检查项目需结合年龄、既往史、禁忌和医生建议确认。", 22, INK, max_width=240, line_height=34)
    icon(draw, "doc", 1480, 735, 62)
    footer_note(draw, "来源：PRESALE003 p030；PRESALE008 p011 检查履约时效。")
    save(img, "P06_履约报价_高端早筛与影像检查.png")


def p07_cardio_intro() -> None:
    img, draw = new_slide(7, "服务3｜心脑血管与代谢管理", "从一次指标异常，转为可持续监测、评估和干预")
    rounded(draw, (90, 190, 1650, 355), radius=24, fill="#fffaf7", outline="#ffd5c4", width=2)
    draw_flow(draw, ["监测", "建档", "评估", "干预", "改善"], 150, 225, 1420, 96, ["heart", "doc", "scan", "person", "heart"])
    draw_matrix_cards(
        draw,
        [
            ("heart", "血压/血糖/血脂", "连续指标采集，识别波动和异常趋势。"),
            ("heart", "动态心电", "按场景接入心电监测和医生解读。"),
            ("scan", "颈动脉超声", "心脑血管相关风险的专项筛查之一。"),
            ("doc", "慢病分层", "围绕甲状腺、三高、心脏、脑血管等常见指标。"),
            ("moon", "生活方式管理", "运动、营养、睡眠、用药提醒协同推进。"),
            ("person", "转诊协同", "异常指标进入名医问诊或就医绿通。"),
        ],
        90,
        425,
        1560,
        430,
        cols=3,
        rows=2,
    )
    footer_note(draw, "来源：PRESALE010 p026 慢病管理方案；PRESALE009 p002/p004 智能硬件监测链路。")
    save(img, "P07_服务3_心脑血管与代谢管理.png")


def p08_cardio_delivery() -> None:
    img, draw = new_slide(8, "履约及报价｜心脑血管与代谢管理", "硬件数据、体检报告和家医主动管理形成长期指标闭环")
    rounded(draw, (92, 200, 715, 820), radius=24, fill="#fffaf7", outline="#ffd5c4", width=2)
    section_label(draw, 132, 232, "履约流程")
    steps = ["指标采集：血压、血糖、心电、体检报告", "家医解读：异常指标与趋势变化说明", "风险分层：三高、心脏、脑血管等重点标签", "计划制定：运动、营养、睡眠、用药管理", "异常升级：名医问诊、就医绿通或检查安排"]
    y = 305
    for i, step in enumerate(steps, 1):
        draw.ellipse((132, y, 172, y + 40), fill=ORANGE)
        add_text(draw, (146, y + 6), str(i), 22, PAPER, "bold")
        add_text(draw, (190, y + 2), step, 23, INK, max_width=450, line_height=32)
        if i < len(steps):
            draw.line((152, y + 44, 152, y + 72), fill="#ffcbb8", width=3)
        y += 92
    rows = [
        ("基础管理", "报告解读、指标建档、月度提醒", "可纳入会员权益"),
        ("慢病专项", "控压、控糖、控脂、减重等计划", "按项目/会员自选确认"),
        ("硬件监测", "血压计、血糖仪、动态血压手表、睡眠垫等", "按硬件清单确认"),
        ("异常转诊", "名医问诊、检查加急、就医绿通", "按实际服务确认"),
    ]
    draw_price_table(draw, 780, 285, 840, 92, ["服务项", "内容", "报价口径"], rows, [0.22, 0.50, 0.28], 20)
    rounded(draw, (780, 710, 1620, 820), radius=18, fill=GREEN_SOFT, outline="#b6dac7", width=2)
    add_text(draw, (816, 742), "推荐组合", 24, GREEN, "bold")
    add_text(draw, (816, 782), "档案监管管家 + 慢病专项计划 + 智能硬件监测；必要时接入早筛影像或就医闭环。", 21, INK, max_width=740, line_height=30)
    footer_note(draw, "来源：PRESALE010 p026；PRESALE009 智能硬件资料。")
    save(img, "P08_履约报价_心脑血管与代谢管理.png")


def p09_vaccine_intro() -> None:
    img, draw = new_slide(9, "服务4｜疫苗免疫防护", "按年龄、接种史、抗体结果和禁忌评估配置，不做一刀切推荐")
    draw_matrix_cards(
        draw,
        [
            ("syringe", "流感疫苗", "秋冬季和高频接触场景优先评估，每年按指南更新。"),
            ("shield", "肺炎疫苗", "结合年龄、慢病基础和既往接种史评估。"),
            ("shield", "带状疱疹疫苗", "中老年和免疫状态相关人群重点评估。"),
            ("syringe", "HPV疫苗", "按年龄、性别、既往接种和当地规则确认。"),
            ("syringe", "乙肝疫苗", "先看接种史和抗体，必要时补种或加强。"),
            ("doc", "接种档案", "留观、凭证归档和下一针提醒纳入监管。"),
        ],
        90,
        205,
        1120,
        600,
        cols=3,
        rows=2,
    )
    rounded(draw, (1265, 235, 1645, 780), radius=24, fill="#fffaf7", outline="#ffd5c4", width=2)
    icon(draw, "shield", 1455, 340, 72)
    add_text(draw, (1305, 440), "为什么推荐", 28, ORANGE, "bold", max_width=300, align="center")
    add_text(draw, (1315, 500), "免疫防护适合放进年度健康服务包：先评估可接种性，再匹配疫苗、库存、接种门诊和后续针次提醒。", 24, INK, max_width=300, line_height=38)
    add_text(draw, (1315, 680), "所有接种以当地门诊、疫苗说明书和医生评估为准。", 20, MUTED, max_width=300, line_height=30)
    footer_note(draw, "来源：附件 IMG_7411/IMG_7412 疫苗清单；医学口径按接种门诊和疫苗说明书确认。")
    save(img, "P09_服务4_疫苗免疫防护.png")


def p10_vaccine_delivery() -> None:
    img, draw = new_slide(10, "履约及报价｜疫苗免疫防护", "报价取自附件清单中可识别项目，最终以门诊库存和品牌确认")
    draw_flow(draw, ["接种评估", "品牌确认", "预约接种", "现场留观", "凭证归档", "针次提醒"], 94, 190, 1280, 150, ["doc", "shield", "syringe", "person", "doc", "heart"])
    rows = [
        ("流感疫苗", "国产/进口/组合不同", "约85-353元/剂"),
        ("肺炎疫苗", "23价/13价按年龄评估", "约239元起"),
        ("带状疱疹疫苗", "国产/进口按年龄与禁忌确认", "国产约390元/剂；进口约980元/剂"),
        ("HPV疫苗", "二价/四价/九价按规则确认", "约353-1394元/剂"),
        ("乙肝疫苗", "接种史和抗体结果优先", "约87-208元/剂"),
    ]
    draw_price_table(draw, 108, 420, 1120, 88, ["疫苗", "配置口径", "清单参考价"], rows, [0.22, 0.43, 0.35], 21)
    rounded(draw, (1285, 410, 1638, 850), radius=22, fill="#fffaf7", outline="#ffd5c4", width=2)
    section_label(draw, 1322, 438, "服务边界")
    add_text(draw, (1325, 508), "不替代接种门诊问诊。需核对年龄、孕哺、过敏、急性发热、免疫状态、既往针次和当地库存，并以说明书为准。", 22, INK, max_width=275, line_height=34)
    add_text(draw, (1325, 702), "适合纳入监管：接种凭证归档、下一针提醒、年度复盘。", 22, GREEN, "bold", max_width=275, line_height=34)
    footer_note(draw, "报价来源：IMG_7411.HEIC、IMG_7412.HEIC 人工复核可识别项；最终以门诊实际为准。")
    save(img, "P10_履约报价_疫苗免疫防护.png")


def p11_energy_intro() -> None:
    img, draw = new_slide(11, "服务5｜精力恢复与睡眠营养管理", "围绕状态评估、方案制定和跟踪复盘，不写疗效承诺")
    draw_matrix_cards(
        draw,
        [
            ("cross", "NAD+可选服务", "作为可选项目，需机构评估、禁忌核查和知情确认。"),
            ("moon", "睡眠管理", "睡眠测评、CBT-I相关支持、作息跟踪和复盘。"),
            ("doc", "营养管理", "饮食结构、体重目标、控糖控脂场景的方案支持。"),
            ("heart", "运动计划", "结合体检指标和生活节奏设置可执行计划。"),
            ("person", "心理压力支持", "测评、私密咨询和压力管理课程。"),
            ("scan", "状态追踪", "阶段测评、目标更新和异常就医提醒。"),
        ],
        90,
        205,
        1120,
        600,
        cols=3,
        rows=2,
    )
    rounded(draw, (1265, 235, 1645, 780), radius=24, fill="#fffaf7", outline="#ffd5c4", width=2)
    icon(draw, "moon", 1455, 340, 72)
    add_text(draw, (1305, 440), "为什么推荐", 28, ORANGE, "bold", max_width=300, align="center")
    add_text(draw, (1315, 500), "精力、睡眠、饮食和压力问题往往相互影响。该模块用测评、计划和跟踪，把状态恢复管理纳入年度监管。", 24, INK, max_width=300, line_height=38)
    add_text(draw, (1315, 682), "NAD+仅作为可选服务展示，具体项目以机构评估为准。", 20, MUTED, max_width=300, line_height=30)
    footer_note(draw, "来源：PRESALE004 健康宝页面；PRESALE010 p014 健康计划、睡眠和心理支持内容。")
    save(img, "P11_服务5_精力恢复与睡眠营养管理.png")


def p12_energy_delivery() -> None:
    img, draw = new_slide(12, "履约及报价｜精力恢复与睡眠营养管理", "以评估、计划、咨询和复盘为履约主线")
    draw_flow(draw, ["AI测评", "目标设定", "计划定制", "1V1咨询", "跟踪调整", "阶段复盘"], 94, 190, 1280, 150, ["scan", "doc", "doc", "person", "heart", "doc"])
    rows = [
        ("睡眠管理", "测评、睡眠计划、CBT-I相关支持", "按健康宝/会员方案确认"),
        ("营养管理", "饮食评估、控糖控脂、体重目标", "按项目确认"),
        ("运动计划", "个性化训练计划和阶段跟踪", "按项目确认"),
        ("心理压力支持", "测评、私密咨询、课程支持", "按项目确认"),
        ("NAD+可选服务", "机构评估、禁忌核查、知情确认", "按机构/项目确认"),
    ]
    draw_price_table(draw, 108, 420, 1120, 88, ["服务", "履约内容", "报价口径"], rows, [0.22, 0.48, 0.30], 21)
    rounded(draw, (1285, 420, 1638, 850), radius=22, fill="#fffaf7", outline="#ffd5c4", width=2)
    section_label(draw, 1322, 448, "医学口径")
    add_text(draw, (1325, 520), "该模块用于健康状态管理和服务跟踪，不替代诊断、治疗或药物建议。出现持续不适或异常指标时进入医生问诊或线下就医流程。", 22, INK, max_width=275, line_height=34)
    icon(draw, "person", 1460, 735, 58)
    footer_note(draw, "来源：PRESALE004 健康宝；PRESALE010 p014。")
    save(img, "P12_履约报价_精力恢复与睡眠营养管理.png")


def p13_medical_intro() -> None:
    img, draw = new_slide(13, "服务6｜就医闭环：号、床、刀、检、陪", "把稀缺医疗资源协助和服务进度纳入同一条闭环")
    items = [
        ("person", "号", "专家号/门诊预约\nT+7或T+4服务"),
        ("bed", "床", "住院安排协助\n重疾住院联动"),
        ("knife", "刀", "手术资源协助\n二诊与住院衔接"),
        ("scan", "检", "检查加急\n影像/胃肠镜安排"),
        ("person", "陪", "专人陪诊\n取号、就诊、检查、取药"),
    ]
    x0 = 118
    for i, (kind, title, body) in enumerate(items):
        bx = x0 + i * 310
        rounded(draw, (bx, 248, bx + 255, 640), radius=24, fill=PAPER, outline="#f0c8b7", width=2)
        icon(draw, kind, bx + 128, 348, 64)
        add_text(draw, (bx, 445), title, 58, ORANGE, "bold", max_width=255, align="center")
        add_text(draw, (bx + 28, 520), body, 23, INK, "bold", max_width=200, align="center", line_height=36)
        if i < len(items) - 1:
            arrow(draw, (bx + 268, 444), (bx + 302, 444), ORANGE, 4)
    rounded(draw, (162, 735, 1580, 865), radius=22, fill="#fffaf7", outline="#ffd5c4", width=2)
    add_text(draw, (210, 766), "核心价值", 26, ORANGE, "bold")
    add_text(draw, (210, 812), "资源匹配、进度推进、结果回收和后续随访统一管理。服务强调协助与闭环，不承诺指定医生、指定床位或指定手术结果。", 24, INK, max_width=1270, line_height=34)
    footer_note(draw, "来源：PRESALE008 p011；PRESALE003 p012-p016；PRESALE010 p021。")
    save(img, "P13_服务6_就医闭环.png")


def p14_medical_delivery() -> None:
    img, draw = new_slide(14, "履约及报价｜就医闭环", "按号、床、刀、检、陪组织履约和报价口径")
    rows = [
        ("号｜门诊预约 T+7", "健康档案1人、专科图文1次、专家挂号T+7", "供应490元；APP699元"),
        ("号｜门诊预约 T+4", "健康档案1人、专科图文1次、专家挂号T+4", "供应560元；APP803元"),
        ("陪｜专人陪诊", "覆盖多城市医院；取号、就诊、缴费、检查、取药；4小时", "会员权益或按城市确认"),
        ("检｜检查安排", "普通检查≤3工作日；胃肠镜≤7工作日", "按项目确认"),
        ("床｜住院安排", "住院协助，完成≤10工作日", "会员权益或按方案确认"),
        ("刀｜手术资源协助", "通过二诊、住院、检查加急协同推进", "按方案确认"),
        ("二诊/海外医疗", "国内二诊≤5-7工作日；海外医疗≤7-10工作日", "按方案确认"),
    ]
    draw_price_table(draw, 100, 190, 1325, 82, ["模块", "履约口径", "报价"], rows, [0.25, 0.53, 0.22], 19)
    rounded(draw, (1480, 210, 1660, 760), radius=22, fill="#fffaf7", outline="#ffd5c4", width=2)
    for i, (kind, word) in enumerate([("person", "号"), ("bed", "床"), ("knife", "刀"), ("scan", "检"), ("person", "陪")]):
        cy = 278 + i * 96
        icon(draw, kind, 1535, cy, 30)
        add_text(draw, (1585, cy - 17), word, 30, ORANGE, "bold")
    add_text(draw, (1488, 815), "服务边界：就医服务为协助安排，不承诺指定医疗结果。", 18, MUTED, max_width=270, line_height=28)
    footer_note(draw, "报价来源：PRESALE010 p021；履约时效来源：PRESALE008 p011；资源说明来源：PRESALE003 p012-p016。")
    save(img, "P14_履约报价_就医闭环.png")


def p15_tail() -> None:
    img = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(img)
    draw_background(draw)
    add_text(draw, (78, 70), "平安好医生", 34, ORANGE, "bold")
    add_text(draw, (260, 420), "让每一次健康需求，", 54, INK, "bold")
    add_text(draw, (260, 500), "都有专属响应与闭环管理", 62, ORANGE, "bold")
    draw.rounded_rectangle((264, 612, 390, 622), radius=5, fill=ORANGE)
    icon(draw, "cross", 1440, 500, 84)
    add_text(draw, (1760, 1014), "P15", 18, "#b9a49b")
    save(img, "P15_尾页.png")


def save(img: Image.Image, filename: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    img.save(OUT / filename, "PNG", optimize=True)


SLIDES: list[Callable[[], None]] = [
    cover,
    p02_overview,
    p03_archive_intro,
    p04_archive_delivery,
    p05_screening_intro,
    p06_screening_delivery,
    p07_cardio_intro,
    p08_cardio_delivery,
    p09_vaccine_intro,
    p10_vaccine_delivery,
    p11_energy_intro,
    p12_energy_delivery,
    p13_medical_intro,
    p14_medical_delivery,
    p15_tail,
]


def qa_gate() -> None:
    all_text = "\n".join(TEXT_REGISTRY)
    banned = ["关键人", "高管", "骨干", "平安健康"]
    hits = [term for term in banned if term in all_text]
    if hits:
        raise RuntimeError(f"QA failed, banned terms in slide text: {hits}")
    risky_claims = ["治愈", "疗效保证", "确诊", "治疗方案", "绝对防护"]
    risky_hits = [term for term in risky_claims if term in all_text]
    if risky_hits:
        raise RuntimeError(f"QA failed, medical risk terms in slide text: {risky_hits}")
    files = sorted(OUT.glob("P*.png"))
    if len(files) != 15:
        raise RuntimeError(f"QA failed, expected 15 png files, got {len(files)}")
    for path in files:
        with Image.open(path) as im:
            if im.size != (W, H):
                raise RuntimeError(f"QA failed, bad size for {path.name}: {im.size}")
    expected = [f"P{i:02d}_" for i in range(1, 16)]
    actual = [p.name[:4] for p in files]
    if actual != [x[:4] for x in expected]:
        raise RuntimeError(f"QA failed, numbering mismatch: {actual}")


def write_manifest() -> None:
    manifest = OUT / "source_manifest.md"
    text = """# 专属健康服务监管包 image2 输出说明

## 输出
- 15页PNG，尺寸1920x1080，16:9。
- 品牌呈现统一为：平安好医生。
- 本稿不生成PPTX。

## 来源映射
- 视觉风格：知识库/07_售前材料规范与素材库/02_售前视觉VI与版式规范.md；用户附件版式参考图。
- 会员报价：PRESALE003 p006-p009，个人188元/年、家庭388元/年、尊享1888元/年。
- 就医闭环：PRESALE008 p011；PRESALE003 p012-p016；PRESALE010 p021。
- 高端早筛：PRESALE002 p011/p015；PRESALE003 p030。
- 心脑血管与代谢：PRESALE010 p026；PRESALE009 p002/p004。
- 睡眠营养心理：PRESALE004；PRESALE010 p014。
- 疫苗：IMG_7411.HEIC、IMG_7412.HEIC 人工复核可识别项。

## QA Gate
- 禁用词与品牌误写扫描通过。
- 医学口径通过：疫苗、NAD+、早筛仅写评估、配置、履约和边界，不写疗效承诺。
- 视觉闸门通过：每页16:9，白底橙色体系，流程/矩阵/表格为主体。
"""
    manifest.write_text(text, encoding="utf-8")


def make_contact_sheet() -> None:
    files = sorted(OUT.glob("P*.png"))
    thumbs = []
    for p in files:
        with Image.open(p) as im:
            thumb = im.resize((384, 216))
            thumbs.append((p.name, thumb.copy()))
    sheet_w, sheet_h = 5 * 384, 3 * 256
    sheet = Image.new("RGB", (sheet_w, sheet_h), "#ffffff")
    draw = ImageDraw.Draw(sheet)
    for idx, (name, thumb) in enumerate(thumbs):
        x = (idx % 5) * 384
        y = (idx // 5) * 256
        sheet.paste(thumb, (x, y + 30))
        add_text(draw, (x + 12, y + 5), name, 16, INK, "regular")
    sheet.save(OUT / "contact_sheet.png", "PNG", optimize=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for slide in SLIDES:
        slide()
    qa_gate()
    write_manifest()
    make_contact_sheet()
    print(f"rendered {len(SLIDES)} pages to {OUT}")


if __name__ == "__main__":
    main()

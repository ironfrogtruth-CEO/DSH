---
name: pingan-asset-curator
description: Use this skill when curating visual assets for Ping An Good Doctor HTML/PPT materials, including screening assets for Ping An corporate style, organizing /Users/marcus/Desktop/平安企康/平安健康知识库&技能/素材库, creating tags/manifests/contact sheets, and preparing replaceable HTML asset maps.
---

# Ping An Asset Curator

Use this skill for repeated asset-library work serving Ping An Good Doctor HTML/PPT-style materials.

## Default Paths

- Workspace: `/Users/marcus/Desktop/平安企康`
- Formal asset library: `/Users/marcus/Desktop/平安企康/平安健康知识库&技能/素材库/视觉组件外挂库`
- Knowledge visual rules: `/Users/marcus/Desktop/平安企康/平安健康知识库&技能/知识库/06_素材与视觉调用规范`
- LLM Wiki entry: `/Users/marcus/Desktop/平安企康/平安健康知识库&技能/知识库/00_总索引/LLM_Wiki知识库总入口.md`
- Asset indexes: `/Users/marcus/Desktop/平安企康/平安健康知识库&技能/素材库/视觉组件外挂库`

## Visual Gate

Only keep assets that fit Ping An corporate report style:

- White or light-gray page compatibility.
- Ping An orange `#f05a22`, black/gray text, small amount of health green.
- Prefer monochrome or orange-gray SVG line icons.
- Reject high-saturation multicolor, purple-blue gradients, emoji style, childish cartoon, busy 3D, social-sticker style, and complex backgrounds.
- Every retained asset must have a clear use such as `service.vaccine`, `flow.followup`, `device.medicine_box`, `scene.doctor_consult`.

## Standard Library Structure

Use these readable folders unless the user explicitly changes the taxonomy:

- `01_图标_icon/人群画像`
- `01_图标_icon/服务能力`
- `01_图标_icon/流程节点`
- `01_图标_icon/医疗检测`
- `02_流程箭头_连接组件/右箭头`
- `02_流程箭头_连接组件/闭环箭头`
- `02_流程箭头_连接组件/时间轴`
- `03_场景插画_照片/医生沟通`
- `03_场景插画_照片/企业员工健康`
- `03_场景插画_照片/医务室体检`
- `04_设备产品图/智能音箱`
- `04_设备产品图/药箱药品`
- `04_设备产品图/检测设备`
- `04_设备产品图/APP截图`
- `05_背景装饰/封面背景`
- `05_背景装饰/医疗科技线稿`
- `06_版式参考_不直接入页`
- `99_索引与说明`

## Tagging Requirements

Each formal asset needs:

- `asset_id`
- `display_name`
- `category`
- `subcategory`
- `file_path`
- `source`
- `source_asset_id` or source page
- `semantic_tags`
- `style_tags`
- `replacement_group`
- `color_profile`
- `pa_style_score`
- `safe_for_external`
- `license_status`

Maintain:

- `asset_manifest.json`
- `asset_manifest.csv`
- `html_asset_map.json`
- `license_review.csv`
- `contact_sheet.html`
- `contact_sheet.png` or image equivalent
- `QA_素材库检查报告.md`

## Workflow

1. Inspect candidate assets and existing manifests.
2. Score each asset against the visual gate.
3. Copy accepted assets into the formal library. Do not move canonical source files from the knowledge base.
4. Delete rejected files only from candidate/import folders, not from original knowledge sources.
5. Convert SVGs to controllable orange/currentColor when practical.
6. Generate or update manifests and contact sheet.
7. Build an HTML test page when asset changes affect the editor.
8. QA for visual consistency, source, license status, and replacement groups.

## Final Answer Checklist

- Count accepted/rejected assets.
- Identify changed manifest files.
- State whether the contact sheet looks stylistically unified.
- Flag license items still needing manual review.

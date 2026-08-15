# 平安企康视觉组件外挂库

本库用于 HTML 汇报材料、PPT 风格页面和企业健康报告杂志版的视觉组件选择。

## 调用顺序

1. 选择 `10_style_tokens/style_tokens.json` 中的 `style_id`。
2. 从 `00_registry/visual_component_registry.json` 选择组件或素材。
3. 在页面计划中记录 `style_id/component_id/asset_id`。
4. QA 检查组件是否真实落地到 HTML/PPT。

## 目录

- `10_style_tokens/`：色彩风格。
- `20_components/`：数据卡片、进度条、商品焦点组件、环形图、饼图、柱状图、占比柱状图。
- `30_icons/self_generated/`：可默认打包的自绘图标/形状。
- `40_images/internal_reference/`：内部来源图片，仅当前项目内使用，不默认外发。
- `50_layout_references/`：版式参考，不直接入页。
- `90_inactive/needs_license_review/`：未完成授权复核的 iconfont 等素材，不纳入默认可用库。

## iconfont 规则

iconfont 可作为后续补充来源，但必须逐个完成授权复核后，才能从 `90_inactive` 移入 active 注册表。

## 外部下载闸门

iconfont 支持下载 SVG/PNG 等格式，但素材版权归作者/原站点；商业或外发使用必须逐个确认授权。未授权复核前，下载项只进入 `90_inactive/needs_license_review/`，不得进入 active 注册表。

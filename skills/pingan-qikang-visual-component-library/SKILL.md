---
name: pingan-qikang-visual-component-library
description: 平安企康 HTML/PPT 材料视觉组件外挂库，负责色彩风格、数据卡片、图表组件、图标与素材注册表。
---

# 平安企康视觉组件外挂库 Skill

## 默认路径

- 项目根：`/Users/marcus/Desktop/平安企康/平安健康知识库&技能`
- 组件库：`素材库/视觉组件外挂库/`
- 注册表：`素材库/视觉组件外挂库/00_registry/visual_component_registry.json`

## 组件调用原则

1. 先按材料目标选择 `style_id`，再选择 `component_id`。
2. 页面计划必须记录 `style_id/component_id/asset_id`，便于 QA。
3. `needs_license_review` 的素材不得进入默认可打包目录。
4. iconfont 资源必须完成授权复核后才能加入 `active` 注册表。
5. HTML/PPT 输出必须保留组件 ID 或等价元数据。

## 携带工具

- `tools/build_pingan_asset_library.py`

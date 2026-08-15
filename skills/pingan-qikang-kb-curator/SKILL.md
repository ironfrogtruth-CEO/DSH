---
name: pingan-qikang-kb-curator
description: 平安企康知识库摄取、纯享版打包、来源摘要、索引与 QA 闸门维护。
---

# 平安企康知识库整理 Skill

## 默认路径

- 项目根：`/Users/marcus/Desktop/平安企康/平安健康知识库&技能`
- 结构化知识库：`知识库/`
- 纯享版：`知识库纯享版/`
- 原始文件归档：`原始文件/`
- QA：`知识库/99_QA/`

## 工作规则

1. 先规划再执行。
2. 结构化知识优先进入 `00_总索引` 至 `07_售前材料规范与素材库`。
3. 原始图片、OCR 明细、原始文件不得进入纯享版。
4. 对客材料统一使用“服务使用”“服务使用率”。
5. QA 是闸门；检查失败必须回退执行或规划。

## 携带工具

- `tools/extract_image_ocr.py`
- `tools/vision_ocr.swift`
- `tools/build_chatgpt_upload_pack.py`

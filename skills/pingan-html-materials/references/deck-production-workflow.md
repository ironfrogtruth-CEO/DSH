# HTML 版 PPT 生产工作流

## 1. 内容规划

先读取知识库，再写逐页稿。不得直接进入 HTML。

知识读取顺序：

```text
完整知识库存在时：
知识调用架构 -> 分类目录索引 -> 实体索引 -> 关系索引 -> 主题 Wiki -> 来源追溯

完整知识库不存在时：
resources/knowledge/presale -> 仅作便携售前回退
```

页级规划必须包含：

```json
{
  "page_no": 1,
  "title": "",
  "core_message": "",
  "knowledge_mode": "full | portable_fallback",
  "entity_refs": [],
  "relation_refs": [],
  "knowledge_sources": [],
  "source_refs": [],
  "truth_status": "verified | needs_review | portable_only",
  "layout_type": "",
  "components": [],
  "asset_requirements": [],
  "background": {
    "replacement_group": "",
    "asset_id": "",
    "opacity": 0.12
  },
  "editable_widgets": [],
  "qa_notes": ""
}
```

`truth_status` 规则：

- `verified`：已由完整知识库 Wiki + 来源追溯共同支撑。
- `needs_review`：价格、权益次数、医学口径、等待期等易变或需人工复核事实。
- `portable_only`：只使用了 skill 内置精简知识，不得视为完整真相。

## 2. 图形化表达选择

- 信息总览：能力地图、流程闭环、矩阵总览。
- 产品权益：权益表、分档卡、服务清单。
- 服务流程：横向步骤、时间轴、闭环箭头。
- 履约证明：手机截图阵列、流程截图、案例卡。
- 资源协同：左右协同图、分层漏斗、资源闭环。

## 3. 素材调用

优先读取：

```text
resources/visual-component-library/00_registry/visual_component_registry.json
```

默认只使用：

```text
safe_for_external=true
pa_style_score>=4
html_usage=default_candidate
```

iconfont 素材若为 `needs_review_iconfont`，只能作为候选，不默认外发。

## 4. HTML 生成要求

- 每页 `.slide` 固定 1280×720。
- 每个可移动元素必须包在 `.widget` 内。
- 所有文字进入 `.widget-content[contenteditable=true]`。
- 图片元素必须带 `data-asset-id` 与 `data-replacement-group`。
- 背景透明度优先 0.08-0.18；照片背景不得超过 0.22。

## 5. PDF 导出要求

- 导出前调用 `EditableReportDeck.prepareForPrint()`。
- 打印 CSS 必须隐藏工具条、拖拽手柄、删除按钮、辅助线、素材替换面板。
- PDF 页尺寸保持 1280×720，分页不得串页。

# Codex Build Prompt：可编辑 HTML 汇报材料

你需要生成一份 16:9 HTML 汇报材料，而不是 PPTX。

## 输入

- 主题：
- 受众：
- 页数：
- 视觉风格：
- 内容素材：
- 是否需要预留图片区：

## 生成要求

1. 每页使用 `.slide`，尺寸 1280×720。
2. 每个可编辑模块使用 `.widget`。
3. 所有文字必须可编辑。
4. 图片区域使用 `.image-slot`，双击可插图。
5. 每页尽量预留图片区域，减少用户后续拖拽和缩放。
6. 页面布局必须服务内容，不能机械套模板。
7. 企业汇报材料必须高信息密度，每页至少 3 个信息块。
8. 注入 `report-theme.css` 和 `editor-core.js`。
9. 编辑控件必须在 PDF 打印时隐藏。
10. 生成后执行 QA 清单。
11. 若用户没有指定其他风格，默认采用 `平安汇报模版`，并读取 `references/pingan-report-template.md`。
12. 平安汇报模版要求：浅绿蓝背景、平安橙标题、深绿成果强调、白底薄线卡片、右侧橙色竖条/点阵、底部注释和页码。
13. 业务/产品/经营类页面优先使用高密度图表、矩阵、分栏、KPI 亮点栏，不生成网页式空旷 hero 页。
14. 若主题属于售前方案、产品介绍、客户合作方案、运营商权益包、地产/物业健康养老、养老、智能硬件、健康宝、企康会员或企业补充医疗，必须读取 `references/pingan-presale-template.md`，并以 `resources/knowledge/presale` 为知识底座。
15. 售前方案优先使用客户痛点、产品权益、履约流程、服务闭环、App/小程序截图、硬件展示、案例证明和 FAQ 组件。
16. 使用素材时优先查 `resources/pingan-materials/99_索引与说明/html_asset_map.json`；素材元素必须保留 `data-asset-id` 与 `data-replacement-group`。
17. 本地售前素材需要保留 `PRESALE### p##` 或 `PRESALE###_A####` 追溯编号。
18. 售前材料不得无来源编造价格、权益次数、服务范围、等待期、案例成效和资源数量。
19. 输出 HTML 前先形成逐页稿，写清每页组件、图形化表达、素材替换组、背景与透明度。
20. 导出 PDF 前调用 `EditableReportDeck.prepareForPrint()`，确保 PDF 无编辑控件。
21. 若存在完整 `知识库/`，必须先读取 `00_总索引/知识调用架构.md`、`实体索引.csv`、`关系索引.csv`、`知识库文件清单.csv` 和 `检索与引用规范.md`。
22. 完整知识库存在时，按“实体索引 -> 关系索引 -> 主题 Wiki -> 来源追溯”形成事实链，再写逐页稿。
23. 逐页稿必须标注 `knowledge_mode`、`entity_refs`、`relation_refs`、`wiki_sources`、`source_refs`、`truth_status`。
24. 若只使用 `resources/knowledge/presale`，必须把 `truth_status` 标为 `portable_only`，不得把精简知识包当作完整事实真相层。

## 输出

- report.html
- 如可行，生成 report_check.pdf

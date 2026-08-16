# CHANGELOG

## v2.3.0

- 新增完整知识库调用路由，优先走 `实体索引 -> 关系索引 -> 主题 Wiki -> 来源追溯`。
- 新增 `references/knowledge-routing.md`，明确完整知识模式与便携回退模式的边界。
- 逐页稿新增 `knowledge_mode`、`entity_refs`、`relation_refs`、`source_refs` 和 `truth_status`。
- 更新 build prompt、QA 清单和可移植说明，避免把精简售前知识包误当完整事实真相层。

## v2.2.0

- 接入 `知识库/07_售前材料规范与素材库`，新增“平安好医生售前方案风格”。
- 新增 `references/pingan-presale-template.md`，定义售前方案结构、VI、组件、素材调用和禁令。
- 更新 build prompt 与 QA 清单：售前方案必须读取本地售前知识库并保留 `PRESALE` 追溯编号。
- 扩展 `assets/report-theme.css`，新增售前封面、目录、痛点卡、能力图、产品卡、权益表、履约流程、手机截图、硬件展示和案例证明组件类。

## v2.1.0

- 解析 `PPT模版` 三份 PDF，提取并固化“平安汇报模版”。
- 将平安橙、深绿、浅绿蓝背景、右侧橙色竖条/点阵、底部波纹和页脚页码写入默认主题。
- 新增 `references/pingan-report-template.md` 作为默认设计语言依据。
- 新增平安汇报组件类：页标题、薄线卡片、KPI 盒、目录项、封面 A 形占位、页脚注释等。
- 更新模板、示例、生成提示和 QA 清单，使后续汇报材料默认贴近平安业绩发布 PDF 风格。

## v2.0.0

- 固化 Editable HTML Report Deck 定位
- 增加图片区域预留规则
- 增加组件拖动 / 缩放 / 删除
- 增加选中文字字体 / 字号 / 颜色调整
- 增加自由文字插入
- 增加页面删除
- 增加页面背景图和透明度
- 增加自动对齐辅助线
- 增加表格单元格对齐
- 固化平安健康橙色视觉方案
- 明确：风格参考不等于照搬版式

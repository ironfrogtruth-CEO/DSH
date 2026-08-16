# Editable HTML Report Deck Skill

这是一个用于生成 16:9 可编辑 HTML 汇报材料的 skill，适用于内部汇报、售前方案、产品介绍、客户合作方案和系统建设方案。

## 快速使用

1. 准备汇报主题、故事线、页数、视觉风格。
2. 按 `templates/editable-report-template.html` 生成 HTML。
3. 每页使用 `.slide`，每个可编辑元素使用 `.widget`。
4. 需要插图的位置使用 `.image-slot`。
5. 引入 `assets/editor-core.js` 和 `assets/report-theme.css`。
6. 打开 HTML 后可编辑、拖动、缩放、插图、删页、保存、打印 PDF。

## 核心能力

- 16:9 页面
- 文字可编辑
- 组件可拖动 / 缩放 / 删除
- 选中文字改字体 / 字号 / 颜色
- 插入自由文字
- 删除整页
- 页面背景图 + 透明度
- 图片区域双击插图，自适应区域
- 自动对齐辅助线
- 表格单元格左对齐 / 居中
- 保存 HTML
- 打印 / 保存 PDF

## 设计原则

页面规划时必须预留图片区，尽可能减少用户后续拖动和缩放。

## 默认视觉依据

默认采用“平安汇报模版”。该设计语言已固化在：

- `references/pingan-report-template.md`
- `assets/report-theme.css`
- `templates/editable-report-template.html`

后续生成 PPT 替代稿或汇报材料时，除非用户明确指定其他风格，否则应按该模版输出。

当生成售前方案、产品方案、运营商权益包、地产/物业健康养老、养老、智能硬件、健康宝、企康会员或企业补充医疗材料时，叠加“平安好医生售前方案风格”，并调用：

- `references/pingan-presale-template.md`
- `resources/knowledge/presale`
- `resources/pingan-materials`

当存在完整外部 `知识库/` 时，必须优先使用完整知识库，并按：

```text
实体索引 -> 关系索引 -> 主题 Wiki -> 来源追溯
```

形成事实链。完整知识库缺失时，才回退到 `resources/knowledge/presale`。

## 可移植部署

迁移到 Coze、WorkBuddy 或其他工作台时，整体复制 `html编辑器skill/`。该目录已包含：

- 精简售前知识库：`resources/knowledge/presale`
- 精选素材库：`resources/pingan-materials`
- 机器配置：`skill.config.json`

生成 HTML 时不要写死本机绝对路径。若 HTML 输出在 skill 文件夹外，应在 `<body>` 设置 `data-asset-root` 指向素材库根目录。

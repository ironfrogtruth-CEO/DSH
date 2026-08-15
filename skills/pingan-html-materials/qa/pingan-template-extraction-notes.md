# 平安汇报模版提取 QA 记录

## 来源 PDF

| 文件 | 页数 | 页面尺寸 |
| --- | ---: | --- |
| `PPT模版/1765445073932_2025年中期业绩发布.pdf` | 24 | 960 x 540 pt |
| `PPT模版/1765446517049_2024年度业绩发布.pdf` | 20 | 960 x 540 pt |
| `PPT模版/1774446665534_平安健康医疗科技有限公司 2025 年业绩发布.pdf` | 25 | 960 x 540 pt |

## 抽取结果

已提取并写入：

- 色彩体系：平安橙 `#f05a22`、深绿 `#1d8153`、浅蓝底 `#eaf5fb`、浅绿白 `#f5faf4`、线框灰 `#bfbfbf`。
- 背景规则：浅绿蓝渐变、底部波纹/点阵、右侧点阵、右边缘橙色竖条。
- 版式规则：左上橙色标题、薄线卡片、高密度图表、右侧亮点栏、底部注释和右下页码。
- 组件规则：白底薄线卡片、橙/绿顶栏、KPI 指标盒、双 chevron 箭头、目录页 01/02/03 结构。
- 页面类型：封面、前瞻声明、目录、战略全景、经营/KPI、左右分栏、图表、ESG/活动、感谢页、附录表格。

## 写入位置

- `references/pingan-report-template.md`
- `SKILL.md` 第 7 节默认视觉风格
- `assets/report-theme.css`
- `templates/editable-report-template.html`
- `examples/minimal-deck.html`
- `prompts/codex-build-prompt.md`
- `qa/qa-checklist.md`

## 渲染检查

已用无头 Chrome 渲染 `examples/minimal-deck.html`，输出检查图：

- `/private/tmp/pingan_html_skill_example.png`

检查结论：

- 平安橙标题、深绿强调、浅绿蓝背景、右侧橙色竖条/点阵、白底薄线卡片均可渲染。
- 编辑工具条在普通浏览器视图可见，符合编辑态要求；打印态由既有 `@media print` 规则隐藏。

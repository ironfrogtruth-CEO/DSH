---
name: pingan-html-materials
description: 生成 16:9 可编辑 HTML 汇报材料，适合作为 PPT 替代稿、内部汇报稿、售前方案、产品介绍、PRD 展示稿和系统建设方案稿；支持轻量编辑、浏览器打印与 PDF 导出，并执行平安企康视觉风格、知识库真源与 QA 闸门。用于平安企康 HTML 材料、方案页、运营商/地产/物业健康养老方案、养老/智能硬件/健康宝/企康会员/企业补充医疗材料，或用户要求可编辑 HTML 版式材料时。
whenToUse: 用户需要 16:9 可编辑 HTML 汇报/方案材料、HTML 版 PPT 替代稿，或浏览器打印 PDF 且不丢失显示效果的页面时。
---

# Editable HTML Report Deck Skill

## 1. Skill 定位

本 skill 用于生成 **16:9 可编辑 HTML 汇报材料**，适合作为 PPT 替代稿、内部汇报稿、方案材料、PRD展示稿、系统建设方案稿。

它不是完整网页编辑器，也不是传统 PPT 生成器。

核心目标：

- 先生成一份内容完整、页面布局均衡、视觉风格统一的汇报材料；
- 再提供必要的轻量编辑能力，便于用户微调；
- 最终支持浏览器打印 / 保存为 PDF，且不丢失显示效果。

## 2. 默认输出形态

默认生成：

```text
report.html
```

必要时同时输出：

```text
report_check.pdf
```

在平安企康工作区内，正式交付文件不得停留在 skill 目录或应用 `outputs/` 中，必须复制或导出到：

```text
/Users/marcus/Desktop/平安企康/03_产物交付/{项目类型}/{项目名_YYYYMMDD}/
```

路径规则以 `平安健康知识库&技能/00_主入口_知识技能与产物路径规范.md` 为准。

页面要求：

- 每页固定 16:9。
- 默认尺寸：1280 × 720 px。
- 打印时每页独立分页。
- 编辑控件、拖拽手柄、缩放点、页面工具条、辅助线在 PDF 中必须隐藏。

## 2.1 可移植资源结构

本 skill 迁移到 Coze、WorkBuddy 或其他工作台时，应整体复制 `html_materials/skill/` 文件夹。默认资源均使用相对路径：

- 运行时：`assets/editor-core.js`。
- 主题：`assets/report-theme.css`。
- 模板：`templates/editable-report-template.html`。
- 素材库：`resources/visual-component-library`。
- 售前知识库：`resources/knowledge/presale`。
- 机器配置：`skill.config.json` 与 `resources/resource-manifest.json`。

生成 HTML 时不得硬编码本机 `/Users/...` 绝对路径。若 HTML 输出到 skill 文件夹外，必须在 `<body>` 设置 `data-asset-root` 指向素材库根目录。

## 2.2 知识调用顺序

当用户要求生成业务材料、产品方案、服务组合、逐页稿或事实性内容时，先判断是否存在外部完整 `知识库/`。

若存在，必须优先读取：

- `00_总索引/知识调用架构.md`
- `00_总索引/分类目录索引.md`
- `00_总索引/实体索引.csv`
- `00_总索引/关系索引.csv`
- `00_总索引/知识库文件清单.csv`
- `00_总索引/检索与引用规范.md`

随后按 `references/knowledge-routing.md` 执行：

```text
实体索引 -> 关系索引 -> 主题 Wiki -> 来源追溯
```

只有找不到完整 `知识库/` 时，才回退到内置 `resources/knowledge/presale`。该模式只支持精简售前知识，不能视为完整事实真相层。

## 3. 适用场景

适合：

- 企业内部汇报材料
- 项目建设方案
- 系统 PRD 展示版
- 经营驾驶舱方案
- 流程机制汇报
- 角色权限 / 流程图 / 系统架构说明
- 需要插入截图并保持版式稳定的汇报材料

不适合：

- 复杂动画演示
- 真正需要 PowerPoint 原生对象二次编辑的材料
- 大量手绘图形设计
- Word 长文档
- 完整网页应用

## 4. 生成原则

### 4.1 先内容，后编辑

页面规划阶段要尽量把布局设计好，减少用户后续拖动组件和调整大小的次数。

用户后续编辑能力是兜底，不是主要生产方式。

### 4.2 页面布局服务内容

不得为了模仿某个模板而牺牲内容表达。

每页根据内容选择：

- 卡片
- 矩阵表
- 横向流程
- 左右协同图
- 指标卡
- 页面截图区
- 系统架构图
- 时间线
- 问题-方案-价值结构

### 4.3 高信息密度

企业汇报材料不能做成“一个标题 + 一句口号”的空页。

每页至少包含：

- 页标题
- 核心判断
- 主体图形 / 表格 / 流程 / 矩阵
- 关键结论
- 管理动作或可观测指标

### 4.4 图片区域预留

页面规划时要主动预留图片插入区域，尤其是：

- 系统首页截图
- 客户监控页截图
- 流程追踪页截图
- 企业健康报告工作台截图
- 组织架构图
- 系统连接器架构图
- 客户案例图

图片区域必须支持双击插入图片，并自动适配区域。

默认 `object-fit: cover`，支持切换为 `contain`。

## 5. 编辑能力要求

必须支持以下能力：

| 能力 | 要求 |
|---|---|
| 文字编辑 | 所有可见文字均应可编辑，包括封面公司名、页脚、说明文字 |
| 选中文字改样式 | 支持字体、字号、颜色、加粗 |
| 组件拖动 | 组件选中后显示拖动手柄 |
| 组件缩放 | 组件选中后显示 8 个缩放点 |
| 组件删除 | 支持组件右上角删除按钮，也支持 Delete 键 |
| 插入自由文字 | 支持新增自由文本框，新文本框同样可拖动、缩放、删除 |
| 删除整页 | 支持删除当前页 |
| 背景图 | 每页可单独插入背景图 |
| 背景透明度 | 每页背景图可独立调整透明度 |
| 图片插入 | 双击图片区插入本地图片 |
| 图片适配 | 图片自动适配图片区，可切换 cover / contain |
| 自动对齐辅助线 | 拖动 / 缩放组件时显示对齐线并吸附 |
| 表格对齐 | 支持表格单元格左对齐 / 居中 |
| 保存 HTML | 支持保存当前编辑后的 HTML |
| 打印 PDF | 支持浏览器打印 / 保存为 PDF |

## 6. 编辑交互规则

### 6.1 不要把全部功能放到底部

底部大工具栏会污染使用体验。

推荐：

- 页面右上角：仅放全局轻量按钮，如保存、打印、插入自由文字。
- 当前页右上角：放删除本页、背景图、透明度、移除背景。
- 组件选中后：显示拖动、删除、缩放手柄。
- 选中文字后：在文字附近弹出迷你工具条。

### 6.2 固定文字也必须可编辑

以下元素不能做成死文本：

- 封面顶部公司名
- 页脚说明文字
- 页码附近说明
- 页标题
- 图注
- 表格内容

所有有文字的地方都应进入可编辑组件体系。

### 6.3 自动对齐辅助线

辅助线不是网格。

拖动 / 缩放时才显示，帮助组件吸附：

- 页面左边界
- 页面右边界
- 页面上边界
- 页面下边界
- 页面水平中心线
- 页面垂直中心线
- 其他组件左 / 中 / 右边界
- 其他组件上 / 中 / 下边界

## 7. 默认视觉风格：平安汇报模版

本 skill 默认采用“平安汇报模版”。该模版来自平安汇报材料解析结果，已固化在 `references/pingan-report-template.md`、`assets/report-theme.css` 与模板中。生成汇报材料时，即使用户没有额外指定视觉风格，也应优先按该模版执行。

完整设计语言见 `references/pingan-report-template.md`。只有用户明确要求其他风格时，才偏离该默认模版。

当用户要生成售前方案、产品介绍、客户合作方案、运营商权益包、地产/物业健康养老方案、养老/智能硬件/健康宝/企康会员/企业补充医疗材料时，必须叠加“平安好医生售前方案风格”。若存在完整知识库，先读 `/Users/marcus/Desktop/平安企康/平安健康知识库&技能/知识库/07_售前材料规范与素材库` 及相关业务 Wiki；若不存在，再回退到本 skill 的 `resources/knowledge/presale`。

售前风格调用说明见 `references/pingan-presale-template.md`，知识底座见：

```text
resources/knowledge/presale
```

完整业务真相层见：

```text
/Users/marcus/Desktop/平安企康/平安健康知识库&技能/知识库
```

### 7.1 色彩

```css
--pa-orange: #f05a22;
--pa-orange-dark: #d94d1f;
--pa-orange-soft: #fff1e8;
--pa-green: #1d8153;
--pa-green-dark: #14683f;
--pa-green-soft: #e9f5ef;
--ink: #2f343a;
--muted: #72777f;
--line: #d9dde3;
--soft: #f6f8fa;
--paper: #fbfefe;
--aqua: #eaf5fb;
--bluegray: #eef6f8;
```

注意：

- 平安健康汇报材料默认主色用平安橙 `#f05a22`。
- 深绿 `#1d8153` 用于增长、成果、能力和经营亮点。
- 背景使用浅蓝、浅绿白和白色，不使用深色大背景。
- 橙色用于标题、重点数字、箭头、标识线、页眉强调。
- 图表优先使用灰柱 + 橙色强调 + 绿色增长，不使用多彩调色盘。

### 7.2 背景

默认采用：

- 浅蓝白到浅绿白背景
- 底部绿色波纹/地形线
- 底部浅蓝点阵科技网格
- 右侧浅灰点阵
- 右边缘短平安橙竖条
- 轻量科技感，不做重装饰

### 7.3 字体

默认：

```css
font-family: "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", Arial, sans-serif;
```

内容页主标题使用近似平安业绩发布材料的楷体/手写标题感：

```css
font-family: "FZKai-Z03S", "KaiTi", "STKaiti", "STKaitiSC-Regular", "PingFang SC", serif;
```

层级：

| 层级 | 字号 |
|---|---:|
| 封面标题 | 48-56px |
| 页标题 | 30-38px |
| 小标题 | 16-22px |
| 正文 | 13-16px |
| 指标数字 | 28-42px |
| 页脚 | 11-13px |

### 7.4 典型组件

默认组件应优先使用：

- 橙色左上页标题。
- 白底薄线卡片。
- 橙色/绿色矩形顶栏。
- 右侧“亮点”指标栏。
- 双 chevron 箭头（绿 + 橙）。
- 底部注释和右下页码。
- 目录页的 01/02/03 纵向章节结构。
- 封面和感谢页的大型 A 形品牌视觉占位。

### 7.5 页面禁令

- 不做深色科技大屏。
- 不做网页式 hero landing page。
- 不使用圆润胶囊卡片作为主视觉。
- 不使用漂浮装饰球和大面积渐变装饰。
- 不省略页码、注释、单位和口径。
- 不牺牲信息密度去追求空旷感。

### 7.6 售前方案叠加规则

售前方案默认更强调：

- 客户痛点、行业趋势、产品权益、服务流程、履约路径和合作案例。
- 白底/浅灰底 + 平安橙标题/表头/流程节点。
- 三档产品卡、权益明细表、横向流程、手机截图阵列、硬件展示和案例证明页。
- 素材优先从 `curated_assets.csv/json` 调用，并保留 `PRESALE### p##` 或 `PRESALE###_A####` 追溯编号。

售前方案不得：

- 脱离知识库编造案例、价格、服务次数、等待期和资源数量。
- 只做口号页，不给产品明细、流程和落地动作。
- 省略服务范围、付费项、免责声明和数据口径。

## 8. 页面规划方法

### 8.1 每页规划字段

每页先写清：

```json
{
  "page_no": 1,
  "title": "",
  "core_message": "",
  "knowledge_sources": [],
  "layout_type": "",
  "components": [],
  "asset_requirements": [],
  "background": {
    "replacement_group": "",
    "asset_id": "",
    "opacity": 0.12
  },
  "content_blocks": [],
  "editable_widgets": [],
  "notes": "",
  "qa_notes": ""
}
```

### 8.2 常用布局类型

| layout_type | 用途 |
|---|---|
| cover | 封面 |
| agenda | 目录 |
| three_cards_plus_summary | 三栏卡片 + 底部结论 |
| matrix_with_side_note | 矩阵表 + 右侧说明 |
| central_architecture | 中央架构图 |
| flow_with_metrics | 横向流程 + 指标 |
| org_collaboration | 左右组织协同图 |
| report_workflow | 报告工单流程 |
| ai_capability_matrix | AI能力矩阵 |
| connector_architecture | 热插拔系统连接器 |
| screenshot_grid | 页面截图矩阵 |
| value_cards | 分角色价值卡 |
| roadmap | 推进路径 |
| closing | 收束页 |
| presale_cover | 售前/客户方案封面 |
| presale_toc | 售前目录/章节页 |
| pain_grid | 客户痛点卡片网格 |
| capability_map | 平安健康能力全景 |
| product_tier | 三档/多档产品权益卡 |
| benefit_table | 权益明细表 |
| flow_steps | 权益领取/履约流程 |
| phone_grid | App/小程序截图阵列 |
| device_showcase | 智能硬件展示 |
| case_proof | 客户案例证明页 |

### 8.3 图片区域规则

图片区域不是事后补丁，页面规划时必须预留。

图片 slot 字段：

```json
{
  "slot_id": "screenshot_overview",
  "x": 60,
  "y": 132,
  "width": 510,
  "height": 170,
  "fit": "cover",
  "hint": "插入管理总览截图"
}
```

### 8.4 素材替换规则

所有由素材库插入的视觉元素必须可替换：

```html
<img
  class="pa-asset-icon"
  src="resources/visual-component-library/30_icons/self_generated/pa_icon_vaccine_syringe.svg"
  data-asset-id="gen.icon_vaccine_syringe"
  data-replacement-group="service.vaccine"
  alt="疫苗接种"
>
```

默认读取 `resources/visual-component-library/00_registry/visual_component_registry.json`。只默认调用 `status=active`、`package_default=true`、`license_status=self_generated` 的素材。

## 9. QA 闸门

生成后必须检查。

### Gate 1：页面规格

```text
if 页面不是 16:9:
    阻断
if 打印分页错乱:
    阻断
if PDF 中出现编辑控件:
    阻断
```

### Gate 2：编辑能力

```text
if 组件不能拖动:
    阻断
if 组件不能缩放:
    阻断
if 组件不能删除:
    阻断
if 页面不能删除:
    阻断
if 不能插入自由文字:
    阻断
```

### Gate 3：文字样式

```text
if 选中文字后字体/字号/颜色不生效:
    阻断
if 固定文字不可编辑:
    阻断
if 字体调整污染整页:
    回退
```

### Gate 4：图片能力

```text
if 图片区域不能双击插图:
    阻断
if 图片不能自动适配区域:
    阻断
if 页面背景图不能设置透明度:
    阻断
if 背景图透明度影响正文:
    回退
```

### Gate 5：材料质量

```text
if 页面全是文本块:
    阻断
if 每页内容密度不足:
    回退
if 页面布局不服务内容:
    回退
if 视觉风格偏离用户要求:
    回退
```

### Gate 6：售前知识与素材边界

```text
if 售前方案未读取 resources/knowledge/presale 或本机售前知识库:
    回退
if 产品权益/价格/案例/资源数量无本地来源:
    阻断或标注需外部检索
if 本地图片素材未记录 PRESALE 编号:
    回退
if 客户商标/人物肖像/第三方品牌未提示授权风险:
    回退
if 默认调用了 needs_review_iconfont 素材:
    阻断
```

## 10. 默认生成流程

```text
1. 解析用户材料和目标
2. 明确汇报对象、使用场景、页数、视觉风格
3. 生成故事线
4. 逐页规划页面结构和图片区
5. 如为售前/产品/客户方案，加载 `resources/knowledge/presale`
6. 读取 `resources/visual-component-library/00_registry/visual_component_registry.json`
7. 生成 16:9 HTML，并给素材元素写入 `data-asset-id` 与 `data-replacement-group`
8. 注入编辑能力脚本和打印 CSS
9. 调用 `EditableReportDeck.prepareForPrint()` 后做 PDF 校验
10. 做 QA 检查
11. 输出 HTML
12. 需要时输出 PDF 校验版
```

## 11. 失败回退

| 失败 | 回退 |
|---|---|
| 页面内容太空 | 回到逐页规划，补充信息块 |
| 页面过度模板化 | 回到内容结构，改为服务内容的布局 |
| 编辑控件影响 PDF | 检查 `@media print` |
| 字体样式不生效 | 检查选区保存与 span 包裹逻辑 |
| 组件拖动失效 | 检查 widget 初始化与 drag handle |
| 固定文字不可编辑 | 把固定文字纳入 widget 体系 |
| 图片区域不适配 | 检查 object-fit 与 slot 容器尺寸 |

## 12. 关键经验

1. 用户要的是“好改的汇报材料”，不是复杂编辑器。
2. 页面生成时要尽量设计好，减少用户拖动需求。
3. 组件拖动、缩放、删除是兜底能力，不能丢。
4. 固定文字不能写死，否则用户会立刻卡住。
5. 风格参考不等于照搬版式。
6. 图片区域要提前规划，不能让用户自己拉框找位置。
7. 文字样式必须基于选中文本局部生效。
8. 辅助线是自动吸附线，不是背景网格。
9. 打印 PDF 的稳定性优先于炫技。
10. Skill 的核心是生产线规则，不是某一份 HTML 文件。

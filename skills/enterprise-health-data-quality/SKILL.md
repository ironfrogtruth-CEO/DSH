---
name: enterprise-health-data-quality
description: Normalize and validate parsed enterprise-health data for types, units, duplicates, missing values, denominators, periods, and source-cell traceability. Use for A02 confirmed-data-package production and blocking claims.
---

# 企业健康数据质量

## 质量流程

1. 验证 A01 源哈希与字段映射未变更。
2. 区分人数、人次、次数、金额、比例、日期和文本；规范展示类型时保留原值与原单元格。
3. 统一可确认的单位；单位冲突、百分比尺度冲突或金额币种不明时阻断对应结论。
4. 识别重复行、重复字段、空值、异常负数、年度错位、分子大于分母和加总不守恒。
5. 每个可用字段必须能追溯至源文件、sheet、单元格、年度、单位和规范化规则。
6. 接受 A01 规范化后的标准四行模板、普通宽表、指标长表和纵向键值表；不得再次假定业务数据只能从源文件第 5 行开始。

## 分级处理

- `ready`：可用于企业结论。
- `warning`：保留数据但限制表达，不自动补值。
- `blocked`：口径或来源无法确认，下游不得使用该结论。

字段不完整时按已有事实继续：缺少的字段、模块和分母进入 `warning`、`sourceBoundaries` 或页面降级规则，不要求填满字段字典。至少存在 1 项可分析业务事实即可形成 A02 确认包；完全没有业务值时返回 `DATA_TEMPLATE_VALUES_EMPTY`，提示用户补充输入，不进行无意义的 5 次重试。

## 输出

产出只读 `confirmed-data-package.v2`、`data-quality-report.v1`和 `blockedClaims`。质量报告同时记录 `inputLayout`、工作表、业务事实数量和兼容性提示。空值和质量问题只进入质检产物，不生成客户可见的“数据缺失”文案。

---
name: enterprise-health-xlsx-ingestion
description: Parse uploaded enterprise-health XLSX or CSV files deterministically, lock the source hash, recognize headers by meaning and aliases, and emit traceable field mappings without relying on spreadsheet plugins. Use for A01 source recognition.
---

# 企业健康字段表导入

## 输入边界

- 只接收用户上传的 `.xlsx` 或 `.csv`。
- 对原始字节计算 SHA-256，锁定文件名、物理路径、大小和数据行数。
- 不修改原文件，不从旧报告、截图或模型文本回填数值。

## 确定性解析

1. 遍历全部工作表，读取共享字符串、单元格值、行列位置和空值；按有效业务值与字段匹配数选择数据工作表，不固定只读第一个 sheet。
2. 自动识别四类输入结构：
   - 标准四行模板：第 1 行字段名，第 2—4 行为说明，第 5 行起为数据；
   - 普通宽表：第 1 行字段名，第 2 行起直接为数据；
   - 指标长表：包含“字段/指标”和“值/数值”列；
   - 纵向键值表：每行一个“字段—数值”。
3. 保留原表头，再用字段字典、别名和唯一包含关系匹配标准字段；字段名称不要求与模板逐字一致。
4. 为每个映射输出 `sourceHeader`、`canonicalField`、`semanticMatch`和原始工作表/行号；缺少模板说明行时从项目字段字典补齐说明、页面支撑和来源口径。
5. 同名字段、模糊映射和无法判定字段进入 `parseWarnings`；不猜测、不丢弃已确认的未知业务字段。
6. 数值、单位和年度保留原值，类型规范化交给 A02。

字段缺失不等于解析失败。只要存在至少一项可分析业务值，就把缺口交给 A02 形成质量提示；只有文件不可读、结构无法识别或完全没有业务值时才要求用户修正输入。

## 输出

产出 `source-recognition.v1`：源文件清单、字段映射、原值行、解析警告和唯一源哈希。本 skill 不依赖外部表格插件或办公软件会话。

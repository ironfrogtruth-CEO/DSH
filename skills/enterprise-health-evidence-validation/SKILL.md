---
name: enterprise-health-evidence-validation
description: Validate official external health evidence and enforce the boundary between public background sources and enterprise-specific facts. Use for A03 source verification and A04 citation and claim checks.
---

# 企业健康外部证据核验

## A03 来源核验

1. 从 A02 主题提取检索词，只使用 A03 Agent 注册的 8 项本地工具。工具代理默认拒绝未登记能力；DeepSeek 不承担联网搜索，也不得把模型记忆当来源。
2. 只接收注册的卫生管理机构、政府部门、WHO 或可核验的 PubMed 文献。
3. 注册来源必须实时抓取正文；PubMed 必须通过 E-utilities 检索、摘要筛选和正文抓取。每个最终 URL 再经过 HTTPS 与官方域名白名单。
4. 核验机构、标题、发布日期、URL、主题适配性、抓取时间和完整正文哈希；保存可审计正文摘录与工具调用回执，去重后分配稳定 `sourceId`。
5. 条件不足、链接不可验证或来源不在白名单时进入 blocked，不用模型记忆补证据。

## A04 边界校验

- 外部证据只能解释定义、公共风险背景、政策依据和建议边界。
- 企业人数、比例、费用、变化和服务使用只能引用 A02 字段或登记公式。
- 不得用公共研究推断该企业的因果关系、疾病诊断或投入收益。
- 对筛查政策和诊疗指南必须同时核对“适用对象、检查项目、是否需要医生判断”三项边界；方案对象不等于企业员工的强制要求。女性“两癌”筛查口径可写 35—64 岁对象及乳腺体检、彩超、乳腺 X 线；宫腔镜仅在异常出血或影像异常等情形下由医生判断，不作为常规筛查建议。

## 输出闸门

每条公共背景结论绑定 `sourceId`；每条企业结论绑定企业字段或公式。两类引用不可互换。缺少实时正文快照、64位正文哈希、ISO抓取时间、正式 URL 或任一声明工具回执时，A03 必须阻断，不能进入 A04。

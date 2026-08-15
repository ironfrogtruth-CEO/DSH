---
name: enterprise-health-business-analysis
description: Turn confirmed enterprise-health facts into traceable risk, service, cost, and management conclusions for HR and union readers. Use for A04 analysis after A02 quality and A03 evidence gates pass.
---

# 企业健康经营视角分析

## 分析单元

每条结论按以下结构生产：

1. `finding`：数据显示了什么。
2. `sourceRefs`：哪些 A02 字段、年度或登记公式支持该判断。
3. `businessMeaning`：对企业健康事务负责人意味着什么。
4. `managementImplication`：下一步应关注的人群、服务或管理动作。
5. `boundary`：不能从当前数据推出什么。

## 核心规则

- 分别处理人群基座、体检异常、理赔与医疗支出、服务触达、商城使用和下年度管理重点。
- 比较必须同币种、同单位、同口径、同分母或明确的年度基准。
- 派生指标必须使用登记公式并保留分子、分母、舍入规则和版本。
- 可能重叠人群的检出率、患病率、异常率、阳性率和发生率不得相加。斜杠分隔的主要证据字段只是字段名清单，必须按报告年份的原字段分别列值。只有原字段明确说明去重，或登记派生指标提供去重公式和`sourceFields`时，才能引用综合人数或综合率。
- 风险名表示“不足/未触达/缺口”，但分子字段表示“已使用/已触达/已参与”时，不得改写为新比例名；保留已确认的原始影响人数，比例进入待确认边界。
- 数据只服务判断；不堆数，不重复解释字段名称。
- A03 公共证据只做背景，不替代企业数据。
- 不得诊断个人疾病，不做因果、疗效或投入回报承诺。

## 输出

输出事实卡、风险卡、费用结论、服务结论、公式登记、证据引用和 blocked claims；为 A05 提供风险与人群，不在 A04 自行创建商品或服务名。

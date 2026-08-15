---
name: goal-first-control
description: Control the local enterprise-health report workflow from the required delivery outcome, truth sources, gates, state transitions, approvals, rollback points, and artifact hashes. Use for A00 orchestration only; it must not generate report content.
---

# 目标与状态总控

## 执行原则

1. 先锁定交付结果、企业、报告周期、唯一数据源和用户授权。
2. 按 `A00 -> A01 -> ... -> A11` 状态机调度；依赖节点串行，只在节点合同允许时并发单页任务。
3. 每个节点启动前核验上游状态、schema 版本、产物路径与 SHA-256。
4. 保留已确认上游；失败时只回滚责任节点及受影响下游。
5. A10 前执行显式授权闸门，A11 通过后才登记交付物。

## 禁止事项

- 不编写分析结论、蓝图、逐页文案或页面组件。
- 不跳过 blocked 节点，不以旧产物替代当次哈希不匹配的产物。
- 不调用注册表外的 Agent、skill、工具、数据源或网络能力。

## 运行回执

记录节点、状态、开始/完成时间、输入产物哈希、输出产物哈希、回滚点、失败原因和用户授权状态。

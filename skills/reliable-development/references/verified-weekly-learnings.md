# 已验证周度经验

本文件只接收“有可核验证据、验证办法和稳定锚点”的周度经验。`reliable-development` 在非平凡开发开始前读取这些规则；它们不能覆盖用户明确要求、事实真源、权限、安全、QA 和回滚门槛。

## 2026-09-01｜周期任务必须有 Host 可执行载体
<!-- lesson:0f012794b2b862bded9ff903fce0f0d7c9ad3c287618dc283752f4af35b8a71c -->

- 证据：`jinwuzhijin-weekly-review` 曾以 `runner=""`、`pipelineSlug=""` 注册，Host ticker 直接跳过；`文章@虾六答` 也曾因 `enabled=false`、`nextRunAt=null` 显示“未排期”。
- 规则：周期任务注册前必须同时验证执行载体、启用状态、cron 和 `nextRunAt`；Host-bound 任务不得再由浏览器计时器自动触发。
- 验证：`extensions/shrimp-shell/heartbeat-scheduler.test.mjs` 必须覆盖无载体拒绝、排期即时回写和浏览器双触发阻断；正式验收必须从 `/api/shrimp/heartbeat/list` 与大神真实 UI 同时回读。
- 来源：`extensions/shrimp-shell/index.js`、`extensions/shrimp-shell/client.js`、`heartbeats.json`、大神心跳面板。
- 锚点：commit `b1de55b`；失败指纹 `heartbeat-carrier-missing`。
## 2026-09-02｜回灌 validate 拒绝只落最小指纹，checks 明细被丢弃，同指纹连续两次拒绝无告警无重试
<!-- lesson:dca301606b2b458d755022c6ec8e9078668d8bb2af83f747ad90e92f58dcb586 -->

- 证据：09-02 09:48 与 09-03 10:11 两次回灌均 VALIDATION_FAILED（backups/evolution/20260902-76193、20260902-64098 两份 failure.json），字段仅 error_code/base_head/proposal_sha256/changed_paths；weekly-evolution-review.mjs 的 failureFingerprint() 不接收 validate 抛错附带的 checks 明细；拒因拖到第 4 期才用静态比对定位；两期复盘各推断一次、人工记忆“周四重试”，无自动告警、无计划内重试（memory:reliable-evolution-weekly-20260902 第 3 期版可证）
- 规则：validate 拒绝时必须把 checks 明细（每项 id/ok/detail 尾部摘要）写入 failure.json，并自动产出告警与一次计划内重试；同指纹第二次拒绝按熔断升级人工介入。Gate 本身不放宽——修的是拒绝后的可读性与闭环。
- 验证：演练 validate 拒绝路径：failure.json 含 checks 数组，能直接读出失败检查 id 与摘要，无需复盘反推；拒绝自动产生 notify 与一次计划内重试记录；重试再拒即告警升级
- 来源：scripts/weekly-evolution-review.mjs（failureFingerprint 与 validate checks 组装段）、backups/evolution/20260902-76193/failure.json、backups/evolution/20260902-64098/failure.json、output:进无止尽/2026-09-02-进无止尽周复盘-第4期.md 第一节
- 锚点：failure_fingerprint:jinwuzhijin-runner-validate-gate-reject-20260902~20260903

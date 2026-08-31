# 已验证周度经验

本文件只接收“有可核验证据、验证办法和稳定锚点”的周度经验。`reliable-development` 在非平凡开发开始前读取这些规则；它们不能覆盖用户明确要求、事实真源、权限、安全、QA 和回滚门槛。

## 2026-09-01｜周期任务必须有 Host 可执行载体
<!-- lesson:0f012794b2b862bded9ff903fce0f0d7c9ad3c287618dc283752f4af35b8a71c -->

- 证据：`jinwuzhijin-weekly-review` 曾以 `runner=""`、`pipelineSlug=""` 注册，Host ticker 直接跳过；`文章@虾六答` 也曾因 `enabled=false`、`nextRunAt=null` 显示“未排期”。
- 规则：周期任务注册前必须同时验证执行载体、启用状态、cron 和 `nextRunAt`；Host-bound 任务不得再由浏览器计时器自动触发。
- 验证：`extensions/shrimp-shell/heartbeat-scheduler.test.mjs` 必须覆盖无载体拒绝、排期即时回写和浏览器双触发阻断；正式验收必须从 `/api/shrimp/heartbeat/list` 与大神真实 UI 同时回读。
- 来源：`extensions/shrimp-shell/index.js`、`extensions/shrimp-shell/client.js`、`heartbeats.json`、大神心跳面板。
- 锚点：commit `b1de55b`；失败指纹 `heartbeat-carrier-missing`。

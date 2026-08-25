# dsh-shrimp-run-status

在会话标签栏下、聊天信息流上方显示当前会话真实虾运行的节点，包括正式 `shrimp_run` 和通过 bash 启动的 `gzh-multi-article` 心跳 runner。

- 只读取 session durable `runningCalls` / `nodes` / `pending`；heartbeat 只接受真实执行 `scripts/heartbeat_gzh_publish.py` 的 bash call，grep/read 等提及不会触发，不根据用户文字猜测运行。
- runner 启动后立即读取固定 `.heartbeat_batch.json` 与 `heartbeats.json` 的最小投影；登录预检阶段也显示组件。checkpoint 产生 run id 后切换到 ShrimpTank canonical run。
- 拿到 `run_id`/`runId` 后，通过 DSH 同源 `/api/shrimp/tank` 只读代理读取 summary 与 status，每 3 秒轮询，终态停止。
- 节点名称、数量、进度和领域来自虾缸 run summary；`data-shrimp-kind` 仅由真实 summary/domain/pipelineSlug 映射。
- 终态可关闭；关闭只在当前浏览器会话按 `sessionId + runId` 持久隐藏组件，不删除 run、节点或产物；出现新 runId 自动重新展示。
- 点击组件或节点通过 `shrimp:request-library` 安全事件打开“我的虾”现有详情，不跳任意 URL。

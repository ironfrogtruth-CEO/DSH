# dsh-shrimp-run-status

在会话标签栏下、聊天信息流上方显示当前会话真实 `shrimp_run` 的运行节点。

- 只读取 session durable `runningCalls` / `nodes` / `pending`，不会根据用户文字猜测运行。
- 拿到 `run_id`/`runId` 后，通过 DSH 同源 `/api/shrimp/tank` 只读代理读取 summary 与 status，每 3 秒轮询，终态停止。
- 节点名称、数量、进度和领域来自虾缸 run summary；`data-shrimp-kind` 仅由真实 summary/domain/pipelineSlug 映射。
- 终态可关闭；关闭只在当前浏览器会话按 `sessionId + runId` 持久隐藏组件，不删除 run、节点或产物；出现新 runId 自动重新展示。
- 点击组件或节点通过 `shrimp:request-library` 安全事件打开“我的虾”现有详情，不跳任意 URL。

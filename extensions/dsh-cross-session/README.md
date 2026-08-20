# dsh-cross-session

Host-only、显式调用的跨会话关联 MVP。它不订阅会话、不在 turn 前自动读取、不修改 UI，也不把历史内容注入模型上下文。

## 数据边界

默认 SQLite 文件为 `~/.dsh/cross-session/cross-session.sqlite`，可用 `DSH_CROSS_SESSION_DB` 指定。SQLite 使用 WAL、事务和 append-only event log；projection 与 association 是可重建视图。每个实体 projection 有 revision，写入可用 `expectedRevision` 做 CAS；`idempotencyKey` 或稳定事件指纹防止重复事件。

关系类型固定为：

- `continues`：SESSION → SESSION 或 SESSION → TASK；`forks`：SESSION → SESSION
- `belongs_to` / `depends_on`：TASK → PROJECT / TASK
- `produces`：TASK → ARTIFACT
- `constrains`：DECISION → TASK
- `resumes_at`：CHECKPOINT → TASK 或 SESSION

## 项目身份

调用者必须显式提供 `projectId` 或 `cwd`。有 git remote/repository identity 时，`projectId` 只代表仓库；没有 remote 时，`projectId` 稳定降级为 canonical cwd。branch/worktree 只进入独立的 `workspaceId`/`workspaceFingerprint`，不会把同一仓库不同分支拆成不同 project。不会隐式使用当前项目，也不会把不同 project 的 session 混在一起。

只提供 `projectId` 的 related 查询无法用 cwd 筛选 live session，因此结果只代表已建立的 project projection/relations，不宣称完整 session corpus；如需按当前工作区筛选，请显式提供 cwd（以及可选 branch/worktree）。

## 工具

- `cross_session_associate`：显式写入关系，支持 evidence、source、revision/CAS 和幂等键。
- `cross_session_related`：显式读取并按 project/cwd/title/lineage/relation 评分，返回 explain/provenance。
- `cross_session_resume_context`：显式返回最新 TaskGraph capsule、session refs 和可选 memory refs，结果含 `injection.auto=false`。
- `cross_session_rebuild`：默认 `dryRun=true`，只调用 sessionQuery 的 `listSessions/readTitle/traceSession`，只索引 header/title/lineage，绝不调用 `readSession`。

session 历史、旧标题和关联 evidence 都标记为 `untrusted`，不应当被当作命令执行。`@local/dsh-memory`、`@local/dsh-intelligence` 只在显式 `resume_context` 调用且确有查询条件时通过公开 API 尝试读取；不可用时降级为空 refs。

# @local/dsh-dingtalk-status

只读状态投影。官方 `@dingtalk-real-ai/dsh-dingtalk@0.6.2` 负责凭据、Stream、会话、AI Card 和 setup；本扩展只读取其本地脱敏状态，并复用现有 `sidebar.footer.action` 显示连接状态与最多五个最近绑定会话。

绑定文件只提供 canonical session id；标题、创建时间和运行态从可用的 session-query/persistence/agents 只读投影。状态 API 不返回 Client ID、Client Secret、staffId、conversationId、sessionWebhook、绑定口令、原始状态对象或日志，也不从 UI 写配置、执行命令、发送消息或建立外部连接。

## 钉钉大神控制台

控制台卡片合同见 [`architecture/dingtalk-control-card.v1.json`](../../architecture/dingtalk-control-card.v1.json)。它是同一套真源的展示和授权层，不是第二套会话或任务状态机。

| 视图 | 显示内容 | 允许动作 | 无卡片模板时的命令 |
| --- | --- | --- | --- |
| 首页状态 | 插件版本、凭据是否齐全、管理员绑定、Stream、AI Card、绑定会话数、最近观测 | 刷新、切换视图 | `/status`、`/menu`；首次配置运行固定 setup 命令 |
| 会话 | 最多五条会话序号、标题、创建时间、运行状态 | 打开、重开当前会话、刷新 | `/sessions`、`/session use <序号或ID前缀>`、`/new`、`/stop` |
| 模型与推理 | 模型序号、显示名、提供方、推理等级、当前标记 | 选择、恢复默认、刷新 | `/models`、`/model use <provider>/<model> [effort]`、`/model reset`、`/effort <level>` |
| 任务控制 | 当前任务状态、是否执行中、是否等待审批、更新时间 | 停止、重开、刷新 | `/status`、`/stop`、`/new` |
| 产物 | 产物序号、文件名、类型、大小、更新时间 | 在大神本地会话打开、刷新 | `/artifacts`；产物不上传钉钉 |

所有卡片动作使用稳定 `actionKey` 和槽位参数：`sessionSlot`、`modelSlot`、`artifactSlot`。执行前必须根据当前 `bindings`、`sessionQuery`、`llm` 和官方连接器状态重新解析；卡片上的标题、状态或过期参数不能直接作为执行依据。所有读写动作只接受管理员，敏感操作仍由官方连接器审批；状态、路径、凭据和调试信息不进入卡片。

已发布的控制台模板为 `Dashen Control Center v1`（`f42ee85c-bdb9-4197-b8b7-4379e9b64878.schema`），与现有审批/Plan Review 的 `interactionCardTemplateId` 相互独立。`/menu` 优先投放该模板，使用 `view`、`sessionSlot`、`modelSlot`、`effortSlot`、`taskAction` 动态表单字段；选择只更新同一卡，提交才执行动作。模板缺失、投放失败或回调异常时显示固定命令，不能伪造“已执行”。

2026-08-29 真实验收：Android 已通过新 `/menu` 卡片渲染与“查看内容”同卡切换；iOS 按用户明确决定不纳入本轮验收，不声明已通过。

验收至少覆盖：五个视图导航、加载/空/失败/降级状态、非管理员拒绝、重复回调拒绝、失效槽位拒绝、会话标题和运行状态回读、模型槽位重新解析，以及产物只显示元数据并回到大神本地会话。

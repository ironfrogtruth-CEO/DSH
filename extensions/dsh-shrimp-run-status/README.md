# dsh-shrimp-run-status

`/虾缸` 是一个只读的输入区状态卡。命令由 `commandUi` 注册为纯客户端 action：运行时先消费精确的命令 token，再打开当前会话的虾缸卡片，不发送 prompt、不执行 Host command，也不写入聊天节点。

卡片注册在 `conversation.input.dock`，进入输入区的正常文档流，打开时增加 composer 高度并把对话可视区向上推，不遮挡消息。关闭时卡片本身返回 `null`，但保留低频只读主列表 watcher：前台每 12 秒、页面 hidden 每 30 秒发现新的 active signature；发现未被当前会话关闭过的运行会自动重新打开卡片。打开时串行刷新（每次读取完成后等待 4 秒），关闭或切换会话会取消在途请求；主列表读取失败时关闭态保持安静，手动打开后显示整卡错误，单只虾的 summary 失败只在该虾旁显示“真实节点暂时无法读取”。

关闭按钮或 Esc 会把当前排序后的 `pipelineRef:runId` 集合并入 session-scoped localStorage，并同步更新内存 ref；多只虾从两只缩成一只时仍视为已关闭集合的子集，不会反弹，只有出现未关闭过的新 run identity 才自动出现。若用户在第一次列表响应前关闭，下一次发现只用于登记当时的 identity，不会把刚关掉的卡重新拉起。显式输入或选择 `/虾缸` 会清除当前 dismissal 并强制打开，即使当前没有 active run 也会显示真实已发布虾名单。这个 dismissal 只控制 UI 是否自动出现，不删除或停止后端 run。

卡片只通过同源 `/api/shrimp/tank?path=` 读取三类 canonical 路径：

- `/api/v1/dsh/shrimps`
- `/api/v1/runs?limit=50`
- 活跃运行对应的 `/api/v1/runs/{id}/summary`

模型只接受有非空 pipeline ref 的匹配，合并虾条目内嵌运行与运行列表，并按每条流水线保留最新活跃运行。活跃状态包括 `running`、`processing`、`queued`、`trialing`、`awaiting_confirmation`、`awaiting_external`、`waiting_external` 和 `cancel_requested`。读取失败显示错误，不降级为空闲。

有活跃运行时显示 canonical 虾名、状态徽章、总进度、细进度条、当前节点和真实 summary 节点的横向细进度轨；running 节点显示真实百分比与“运行中”，queued 节点显示“排队中”；多只运行才显示小型分段切换。没有活跃运行时，名单实时取自已发布 pipeline，显示“现在没有虾在运行”和中文身份胶囊；没有已发布虾时显示“虾缸里还没有已发布的虾”。支持深浅色、窄屏、焦点可见和 `prefers-reduced-motion`。

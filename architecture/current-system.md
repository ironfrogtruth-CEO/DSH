# DeepSeek Harness 当前系统边界

本文档记录当前本地 Harness 的可验证边界。它是架构护栏的说明，不是运行时配置；运行时配置仍以 `container.manifest.yaml`、`profiles/web/package.json`、各 Host 扩展 `package.json` 和已安装依赖为准。

## 组成

| 层 | 当前职责 | 约束 |
| --- | --- | --- |
| 固定运行时 | `install/node_modules/@deepseek-ai/dsh`，版本合同为 `0.1.1-rc.2` | `container.manifest.yaml`、`install/package.json`、安装包版本必须一致 |
| Profile | `profiles/web/package.json` 及其 bundle 路径 | bundle 只从声明的 link、profile 依赖或固定 install 目录解析 |
| Host 扩展 | `extensions/*/index.js` 及工具实现 | 依赖的 `@deepseek-ai/dsh-*` 必须与 rc.2 对齐；新增 Host/UI seam 必须登记可重放补丁、验证与升级 Gate |
| UI 边界 | `apps/*.swift`、`extensions/**/client.js`、`custom-ui-patches` 中的前端资源 | 只记录和校验哈希，能力建设不得直接改动这些文件 |
| 数据与记忆 | sessions、storages、memories、goal-first-state 等运行数据 | 原始事件追加写入；派生索引可以重建，不能反向覆盖真源 |

## UI 零改动边界

上下文压缩、长期记忆、跨会话关联、任务规划和 Host 工具都必须通过 Host/插件 seam、独立存储或只读投影接入。它们不得为了“方便”修改 `client.js`、Swift 壳、CSS、UI bundle 或 `custom-ui-patches`。正式 UI 基线由 `verify-ui-integrity.mjs record` 生成，由父代理在确认基线后保存；日常检查只运行 `check`。

当前 `extensions/shrimp-shell` 与提交 `60f5afd` 引入的 `extensions/dsh-git` 同时提供 Host API 和客户端桥接，这是已登记的历史兼容 seam，记录在 ADR 和 `fitness-functions.json` 中。它们不是新 Host 扩展的复制模板；新扩展必须保持 Host/UI 分离。

## 数据与架构方向

1. SQLite first：事件索引、任务状态、记忆元数据和评测结果先落 SQLite；向量索引或图数据库只能作为可重建的加速层。
2. Append-only：原始会话事件、压缩 checkpoint、记忆来源和任务 handoff 追加写入；压缩只生成 active view，不删除原日志。
3. No core fork：不 fork 或直接修改 DeepSeek 核心包；需要扩展时使用 Host 扩展、profile patch、外部 store 和可插拔 adapter。
4. 可恢复：每个派生结果带 source event、版本、hash、模型和 prompt 版本；写入失败时保留旧 view，支持重建和回滚。
5. 可观测：架构护栏输出机器可读 JSON，警告与失败分离，禁止把 warning 伪装成通过。

## 当前验证入口

- UI：`node scripts/verify-ui-integrity.mjs check --manifest <正式基线路径>`
- Host：`node scripts/verify-host-architecture.mjs --format json`
- 规则：`architecture/fitness-functions.json`
- 升级合同：`architecture/upgrade-contract.json`
- 升级决策：`architecture/decisions/ADR-0002-rc8-upgrade-compatibility.md`

正式 UI 基线路径必须由部署/父代理明确传入；工具不硬编码、不自动覆盖。

## 当前正式 Host 智能能力

默认用户 preset 是 `reliable-development`（显示名 CyberMarcus），默认父模型是 DeepSeek V4 Pro High。它合并可靠开发与可靠本地开发的必要模型面能力：persistent bash、精确编辑、time context、V4 Flash/Pro 与 Ollama 本地压缩策略、subagent/fork/subagent_flash/execute_flash/workflow 委派。父代理默认负责澄清、架构、规划、集成与最终验收；在线可继续子智能体通过 `subagent_flash` 使用 V4 Flash High，在线一次性执行可用 `execute_flash`，本地父会话则用 generic subagent 继承已选择的 Ollama 路由。可继续子智能体始终保持后台 lifecycle，以 `list_agents`、`send_message` 和 settlement/report notice 维持父子双向通道。子智能体按任务语义从完整漫威角色池动态命名，同一父任务内不重复；名称不替代权限、文件归属或验收合同。低层 live Cordis inspect/mount provider 保持 Host 单例，不在 CyberMarcus 暴露 `cordis_*` 工具；配置编辑使用 bash/fs 与 doctor/profile/architecture 检查，必要时使用 `execute_flash`。默认 `profiles/web` 已启用 `dsh-tool-policy`（observe）、`dsh-intelligence`、`dsh-memory`、`dsh-code-intelligence`、`dsh-cross-session`、`dsh-frontend-qa`、`dsh-evals` 与 `dsh-goal-first-state-machine`。除 `dsh-goal-first-state-machine` 会在 Host 的 `agent/pre-step` 注入有界目标状态、在导出工具前执行 QA Gate，并对明确的单句结果合同做窄输出收敛外，其余智能模块仍只通过显式工具管理或检索，不自动改变模型上下文。`three-provinces-six-ministries` 是 `goal-first-control` 的治理叠加层：复用七节点状态，在 `governance` 投影中记录当前省、部和 Gate；简单任务只做真源、行动、终态三项隐式检查。

`dsh-knowledge-manager` 以 order 100 注册到正式 `settings.section`，从侧边栏 footer 完全移除；设置弹窗左侧导航显示“虾缸知识库”，右侧直接呈现列表/详情双栏管理页面。它只通过同源 `/api/shrimp/tank` 代理访问精确知识库路径：列表/详情读取、内容检索，以及新增、编辑、归档、删除等写操作。模型侧只注册 `knowledge_bases` 只读工具（list/get/search），写操作只能由用户明确点击面板按钮触发；页面不提供上传。删除合同明确为软删除、撤销 Grant、共享源文件保留；搜索每次携带 `Idempotency-Key`。页面保留加载、空、离线、无权限和错误状态，列表与详情在普通 Mac 窗口保持左右同级，支持设置弹窗自身的 Escape 关闭。

`dsh-imessage-bridge` 仍通过 `sidebar.footer.action` 注册“iMessage”，但由稳定 foot-area 标记将它放到设置同层的底部右侧；余额独占上一行，设置入口在左侧。展开态显示图标和文字，折叠态保留清晰图标，弹窗按实时侧边栏宽度居中于会话区域。默认配置为关闭，账号与提醒收件人均为 `weirim@me.com`，只接受白名单一对一 iMessage。白名单线程是大神专用通道：自然语言在没有 route 时自动新建 CyberMarcus 会话，在同一规范化 `chat_identifier` 的 2 小时 route 内直接续聊；`大神：`/`大神:` 只作为可选的明确新开会话命令，`结束对话` 清除 route。普通入站按 allowlist 校验 sender；同一 Apple ID 的 iPhone→本机同步消息允许 `is_from_me=1`，但必须同时满足一对一、`chat_identifier` 精确命中规范化白名单；审计只保存掩码地址。续聊只在原 session 没有 active task 时接受，运行中发送 branded 忙碌提醒。所有 Bridge 出站正文统一加保留标识 `【大神】`，入站端在任何 route 状态下都硬拒绝该标识，GUID+ROWID 继续防重复，因此回复不会重新创建任务。扩展通过私有 `reader.py` 只读 `~/Library/Messages/chat.db`（SQLite `mode=ro`、`query_only`、`busy_timeout`），首次只写最大 ROWID，不重放历史；`attributedBody` 使用固定 vendor `pytypedstream==0.1.0` 的低级事件提取纯文本，不执行任意对象。任务经正式 `/api/session.create`（workspaceId + `reliable-development`）及 `/api/session.prompt` 注入 `workspace-write` 命令与不可信远程任务合同，监听 `session/event` 完成、审批和错误状态；`turn/start` 与无 turn 的 `user/message` 关联，Host 就绪后通过正式 `session.history` 重试恢复未终态任务，已有回执不重复发送。安全合同保持 durable，但聊天 UI 只显示用户实际自然语言。完成时只把处理结果和经 output/realpath/扩展名/大小/敏感文件检查的最多 5 个产物交给静态 AppleScript，不向手机暴露 taskId、sessionId 或内部合同。Bridge 每 45 秒只读同源 `/api/shrimp/heartbeat/list`，首次观察只记录 watermark，之后 runner 的 done/failed/autoPaused 结果各提醒一次，失败可安全重试，不发送日志正文。私有状态仅保存水位、GUID、route/session 映射、回执和心跳 watermark；面板不展示聊天正文、联系人列表或密钥，并提供权限检查、二次确认测试发送、工作区选择和会话跳转。

`dsh-shrimp-run-status` 在正式 `conversation.session.run-status` session slot 渲染会话标签栏下、聊天信息流上方的运行节点卡。它从 durable `useSession` 快照的 `runningCalls`、`nodes` 和 `pending` 识别最新 `shrimp_run`，也识别真实执行 `scripts/heartbeat_gzh_publish.py` 的 bash call；grep/read 或普通对话文字不会触发。heartbeat runner 启动后，Host 只读固定 `.heartbeat_batch.json` 与 `heartbeats.json` 的最小投影，因此登录预检、runs=0 时也能立即显示组件；checkpoint 产生 `run_id` 后，客户端经 DSH `/api/shrimp/tank` 切换到 `/api/v1/runs/{id}/summary` 与 `status` canonical run，每 3 秒轮询，批次终态才停止。节点数量、名称、状态、进度、失败摘要、开始时间和虾名称均来自 pipeline/run summary；`data-shrimp-kind` 只做 article/xiaohongshu/enterprise-health/generic 映射。卡片支持窄屏横向滚动、reduced-motion 和真实“我的虾”安全事件跳转；终态才显示关闭按钮，关闭只按 `sessionId + runId/callId` 持久隐藏当前卡，不删除后端 run、节点或产物，新运行自动重新显示。

Host 长期存活由原生大神 App 自身维护：App 在窗口隐藏后仍保留 30 秒健康 Timer，并监听 macOS 唤醒通知；`127.0.0.1:3080` 缺失时由 App 通过带原子锁的 `enable-host` 幂等恢复，因此 Messages 数据库和 Apple Events 权限始终归属大神。当前用户 LaunchAgent 的 `scripts/host-watchdog` 不直接启动 Host：健康时快速退出；大神已运行但 Host 缺失时等待 App Timer；大神未运行且 Host 缺失时写入 0600 `~/.dsh/private/background-launch` 并用 `open -gj` 静默恢复 App。App 消费该哨兵后不激活窗口，正常双击仍展示界面；显式退出先写入 `~/.dsh/private/service-disabled`，watchdog 不复活。LaunchAgent 不使用粗暴 `KeepAlive`，仍每 30 秒运行一次并保持唯一 listener。心跳仍由 Host 内调度；`虾六答` 的周一/三/五/日 06:00 任务显式启用最多一次、24 小时 miss-window 补跑，正式 runner 启动前幂等调用 `虾缸/scripts/start_for_dsh.sh` 并确认 `/health/live` 与 `/health/dependencies`，失败则不启动文章；其他任务仍保持原有错过窗口即记账不重放合同，幂等键以计划时刻防重复。

新建会话、默认设置和 preset 管理界面只展示 CyberMarcus。Host 仍保留系统 preset 与 `reliable-local` 兼容入口，因为已有非空历史会话把 preset ID 写入了追加式会话日志；删除这些入口会使旧会话无法按原工具和提示合同恢复。兼容入口不再用于新建会话，只有在旧会话完成独立导出或迁移后才可归档。

父会话顶部保留正式子代理入口，信息流底部通过 durable child projection 显示每个子智能体的漫威名、任务与即时状态；点击状态条进入对应 child。左侧 grouped sidebar 不显示“未分组”入口，但 Host/API、搜索与 flat 视图仍保留数据恢复能力。上下文注入事件继续持久化并提供给模型，普通聊天流不渲染该记录；Think 与 Tool call 即时状态保留。

本地 LLM 选择器由 `settings.yaml` 的 `llm-pi-ai.providers.ollama-local` 提供方负责，提供方内部 ID 保持 `ollama-local`，界面显示名为“本地模型”。用户可主动选择的模型只有 `cybermarcus:latest`（显示名“CyberMarcus 本地开发”）和 `qwen3.6:27b`（显示名“Qwen3.6 27B”），两者均声明 32768 上下文、4096 最大输出，以及 text/image 输入。`cybermarcus-codex:latest` 不再作为选择器或 Cyber 压缩策略入口。

Gemma4 (`gemma4:26b-a4b-it-qat`) 只作为虾缸视觉离线回退保留，FLUX (`x/flux2-klein:4b`) 作为本地生图模型保留，EmbeddingGemma (`embeddinggemma:latest`) 作为后台向量检索模型保留；三者由后台适配器按能力静默调用，不进入对话模型选择器，也不承担普通对话压缩策略。所有用户图片无论当前对话模型是否声明 vision，都先经智谱免费 GLM 视觉链识别；只有智谱不可用、限流或无网时才回退 Gemma。原图与用户文字一次提交并保留在 durable 会话，Host 仅把发给最终对话模型的临时请求投影为带 untrusted-data 边界的精简识图结果。TTS/STT 同样不是 LLM 模型：通过固定 `/Users/marcus/.dsh/bin/dsh-local-ai` 的 `tts`/`stt` 子命令，经 bash 或注册工具路由调用。对本地模型隐藏专业工具 schema 只为控制上下文大小，顶层 CyberMarcus 仍可通过后台适配器、`execute_flash` 或具名 Marvel 子智能体调度完整能力。

## 上游升级边界

当前正式运行与离线回退基线都是 `0.1.1-rc.2` 加本仓库可重放补丁。后续候选 Harness 必须安装到隔离目录，不能覆盖当前 `install/` 试错。升级顺序固定为：隔离安装 → 与新版 bundle 做兼容比对 → 重放可维护补丁 → Host/功能回归 → 真实浏览器交互与响应式截图 → 数据恢复演练 → 切换入口。UI manifest、浏览器交互、Host 扩展、图片桥、父子智能体通道与状态流、压缩、记忆、跨会话、任务图和数据恢复是同一组升级 Gate；全部通过后才允许切换正式入口。升级流程不得自动把未知差异写成新基线。

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

默认用户 preset 仍是 `reliable-development`（显示名 CyberMarcus），默认父模型仍按全局设置选择。CyberMarcus 保留受管 bash/job、精确编辑、time context、在线与本地模型、子代理和 Workflow 等原有能力。新增的 `avengers` 是独立可选模式，不改变 CyberMarcus：顶层父代理默认使用 DeepSeek V4 Pro High，只负责目标、规划、派单、监督和验收；每项任务都通过唯一的 `avenger` 工具交给具名 Marvel 英雄或反英雄子代理，子代理固定使用 GLM-5.3-Flash Medium。`dsh-tool-policy` 按 session header 区分父子：父代理只能调用目标、计划、记忆、澄清和子代理控制工具，实际检索、编辑、Shell、浏览器、测试与导出由子代理执行；CyberMarcus 和系统 preset 不进入该门禁。默认 `profiles/web` 已启用 `dsh-tool-policy`（observe）、`dsh-intelligence`、`dsh-memory`、`dsh-code-intelligence`、`dsh-cross-session`、`dsh-frontend-qa`、`dsh-evals` 与 `dsh-goal-first-state-machine`。三省六部、以终为始、谋定后动、七节点 SOP、QA Gate、回退和证据合同在两种自定义模式中保持一致。

`dsh-goal-first-state-machine` 现在把普通分阶段任务与用户明确要求的连续任务分开：普通任务每个 turn 只记录一次状态迁移；“不要中途停”“跑通后再汇报”“只在最后交付”等要求会持久化为 `continuousUntilTerminal` / `silentUntilTerminal`，允许同一 turn 在每个节点真实完成并带 evidence 后继续顺序迁移，仍受 revision CAS、QA 与 export Gate 约束。旧会话缺少这两个字段时，Host 只通过 append-only CAS 从既有目标合同和最新用户指令补齐，不改写历史状态；新指令只允许把连续执行从 false 升级为 true。`shrimp_run` 的免重复确认同样不是宽松放行：Host 只为当前用户消息明确点名的已发布虾签发 `agent + turn + pipelineSlug` 内存 receipt，普通运行一次，明确授权“遇阻自行修复跑通”时最多包含一次重试；跨回合、错虾、模糊推荐和 receipt 耗尽继续走原生审批。

外网分流由 Clash Verge 当前 profile 的持久 rules enhancer 管理。DeepSeek、微信/公众号和小红书域名固定 `DIRECT`；OpenAI/Codex 保持 `🧠 AI 服务` 美国节点；X/Twitter、GitHub、Google 与 Bing 检索域名固定 `🇺🇸 美国节点`。规则只按目标域名生效，不使用 `PROCESS-NAME`，因此不会因 DSH 的 Node/Python 子进程误伤 Codex 或把境外检索改成国内出口。

`dsh-knowledge-manager` 以 order 100 注册到正式 `settings.section`，从侧边栏 footer 完全移除；设置弹窗左侧导航显示“虾缸知识库”，右侧直接呈现列表/详情双栏管理页面。它只通过同源 `/api/shrimp/tank` 代理访问精确知识库路径：列表/详情读取、内容检索，以及新增、编辑、归档、删除等写操作。模型侧只注册 `knowledge_bases` 只读工具（list/get/search），写操作只能由用户明确点击面板按钮触发；页面不提供上传。删除合同明确为软删除、撤销 Grant、共享源文件保留；搜索每次携带 `Idempotency-Key`。页面保留加载、空、离线、无权限和错误状态，列表与详情在普通 Mac 窗口保持左右同级，支持设置弹窗自身的 Escape 关闭。

`architecture/dingtalk-control-card.v1.json` 定义“钉钉大神控制台”的五个视图：首页状态、会话、模型与推理、任务控制、产物。已在“大神”应用正式发布独立模板 `Dashen Control Center v1`（`f42ee85c-bdb9-4197-b8b7-4379e9b64878.schema`）；它使用官方动态表单的 `title`、`form_fields`、`form_status`、`button_text`、`err_msg` 合同，与审批/Plan Review 模板隔离。`/menu` 优先投放互动卡片，选择只更新同一卡片，提交才执行会话、模型、推理等级、停止或新会话动作；卡片值只带版本化槽位，不显示完整 session id、conversation id、staff id、路径、凭据或调试数据。执行前重新从 bindings、`sessionQuery`、`llm` 和 agents 真源解析并校验管理员、版本、幂等与有效期，不建立第二套状态。Android 已完成新卡片渲染与同卡切换真实验收；iOS 按用户决定不纳入本轮验收。模板缺失或卡片失败时降级为 `/menu`、`/status`、`/sessions`、`/session use`、`/models`、`/model use`、`/effort`、`/artifacts`、`/new`、`/stop`、`/help` 命令。底部布局保持余额第一行整行，设置左、钉钉右第二行；折叠态保留 36px rail。

`dsh-shrimp-run-status` 通过 `conversation.input.dock` 在输入框上方渲染连体虾缸运行卡，不遮挡聊天内容。卡片关闭时串行只读 canonical `/api/v1/dsh/shrimps` 与 `/api/v1/runs?limit=50`，前台每 12 秒、页面 hidden 每 30 秒按排序后的 `pipelineRef:runId` signature 发现新 active run；发现未被当前会话关闭过的 signature 自动打开。卡片打开后每 4 秒串行读取对应 `/api/v1/runs/{id}/summary`，节点、进度、当前节点、失败/阻断信息均以 summary 为准，summary 终态不会伪装为运行中；在途请求由 AbortController 清理。关闭时将当前 signature 写入 session-scoped localStorage，抵抗陈旧列表回写；显式 `/虾缸` 清除 dismissal 并强制重开。没有 active run 时只显示 `/api/v1/dsh/shrimps` 返回的真实已发布虾名单，支持窄屏横向轨道、深浅色和 reduced-motion。

Host 长期存活由原生大神 App 自身维护：App 在窗口隐藏后仍保留 30 秒健康 Timer，并监听 macOS 唤醒通知；`127.0.0.1:3080` 缺失时由 App 通过带原子锁的 `enable-host` 幂等恢复，因此钉钉凭据与 Stream 运行态仍由 Host 和官方插件共同管理。当前用户 LaunchAgent 的 `scripts/host-watchdog` 不直接启动 Host：健康时快速退出；大神已运行但 Host 缺失时等待 App Timer；大神未运行且 Host 缺失时写入 0600 `~/.dsh/private/background-launch` 并用 `open -gj` 静默恢复 App。App 消费该哨兵后不激活窗口，正常双击仍展示界面；显式退出先写入 `~/.dsh/private/service-disabled`，watchdog 不复活。LaunchAgent 不使用粗暴 `KeepAlive`，仍每 30 秒运行一次并保持唯一 listener。心跳仍由 Host 内调度；`虾六答` 的周一/三/五/日 06:00 任务显式启用最多一次、24 小时 miss-window 补跑，正式 runner 启动前幂等调用 `虾缸/scripts/start_for_dsh.sh` 并确认 `/health/live` 与 `/health/dependencies`，失败则不启动文章；其他任务仍保持原有错过窗口即记账不重放合同，幂等键以计划时刻防重复。

新建会话、默认设置和 preset 管理界面展示 Host 返回的完整 roster：DeepSeek Harness 原生模式、CyberMarcus 和 Avengers 都可见。`reliable-local` preset 已按用户要求删除，不再出现在新建或管理界面；旧会话 header 仍可显示历史 ID，但缺少该 preset 的会话不能再按原组装恢复。CyberMarcus 继续是默认模式。

父会话顶部保留正式子代理入口，信息流底部通过 durable child projection 显示每个子智能体的漫威名、任务与即时状态；点击状态条进入对应 child。后台 jobs 通过 `conversation.session.header.actions` 提供按需出现的会话 header 入口，显示运行数、耗时和终态，不占主导航；普通 jobs 可跨回复持续，但不跨 Host 重启，跨重启任务必须走 schedule/heartbeat/canonical run。左侧 grouped sidebar 不显示“未分组”入口，但 Host/API、搜索与 flat 视图仍保留数据恢复能力。上下文注入事件继续持久化并提供给模型，普通聊天流不渲染该记录；Think 与 Tool call 即时状态保留。

本地 LLM 选择器由 `settings.yaml` 的 `llm-pi-ai.providers.ollama-local` 提供方负责，提供方内部 ID 保持 `ollama-local`，界面显示名为“本地模型”。canonical 本地模型根固定为 `/Users/marcus/Desktop/虾缸/MODEL`，本机模型安装、迁移和发现均应从此根解析。用户可主动选择的模型只有 `cybermarcus:latest`（显示名“CyberMarcus 本地开发”）和 `glm-marcus:latest`（显示名“GLM-Marcus”，GLM-4.6V-Flash Q4_K_M），两者均声明 32768 上下文、4096 最大输出，以及 text/image 输入，并共用同一 Ollama 本地执行与压缩策略。`cybermarcus-codex:latest` 不再作为选择器或 Cyber 压缩策略入口。

Gemma4 (`gemma4:26b-a4b-it-qat`) 只作为虾缸视觉离线回退保留，FLUX (`x/flux2-klein:4b`) 作为本地生图模型保留，EmbeddingGemma (`embeddinggemma:latest`) 作为后台向量检索模型保留；三者由后台适配器按能力静默调用，不进入对话模型选择器，也不承担普通对话压缩策略。所有用户图片都由 Host 自动接管，不要求用户切换当前主模型：durable 附件先交给 `deepseek-v4-flash-vision-exp`，失败后调用智谱免费 GLM 视觉链，二者都不可用时才回退 Gemma。为让图片到达视觉桥，`deepseek-v4-flash` 与 `deepseek-v4-pro` 在 Host 能力目录中声明 image 准入，但原图不会发送给这两个文本主模型；视觉桥只把带 untrusted-data 边界的精简识图结果投影给当前主模型继续回答。原图与用户文字仍一次提交并保留在 durable 会话。TTS/STT 同样不是 LLM 模型：通过固定 `/Users/marcus/.dsh/bin/dsh-local-ai` 的 `tts`/`stt` 子命令，经 bash 或注册工具路由调用；FLUX、生音频/转写、视频/成片工具（`image_generation_tool`、`tts_tool`、`asr_engine`、`video_composer_tool`）也继续由后台适配器或 Host 工具调度。对本地模型隐藏专业工具 schema 只为控制上下文大小，顶层 CyberMarcus 仍可通过后台适配器、`execute_flash` 或具名 Marvel 子智能体调度完整能力。

## 上游升级边界

当前正式运行与离线回退基线都是 `0.1.1-rc.2` 加本仓库可重放补丁。后续候选 Harness 必须安装到隔离目录，不能覆盖当前 `install/` 试错。升级顺序固定为：隔离安装 → 与新版 bundle 做兼容比对 → 重放可维护补丁 → Host/功能回归 → 真实浏览器交互与响应式截图 → 数据恢复演练 → 切换入口。UI manifest、浏览器交互、Host 扩展、图片桥、父子智能体通道与状态流、压缩、记忆、跨会话、任务图和数据恢复是同一组升级 Gate；全部通过后才允许切换正式入口。升级流程不得自动把未知差异写成新基线。

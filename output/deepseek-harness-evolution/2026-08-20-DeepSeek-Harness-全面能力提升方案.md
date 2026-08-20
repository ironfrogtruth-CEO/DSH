# DeepSeek Harness 全面能力提升方案

> 版本：v1.1（首轮实施与验收记录）
> 调研与本机审计截止：2026-08-20
> 范围：上下文压缩、长期记忆、跨会话关联、任务规划、前端设计、代码开发、架构设计
> 本轮状态：首个 Host MVP 已实现并接入默认 Web；完成图片路由、旧会话恢复、手工/自动 Compaction v2、正式模型/工具、23 组回归、80 个直接样本与离线回滚。按用户“小范围测试即可验收”的口径，本轮升级完成。

## 实施状态快照（2026-08-20 17:06）

| 阶段 | 当前证据状态 | 仍未完成 |
|---|---|---|
| Phase 0 | rc.8 合同统一；doctor 通过；skill-check 修复；UI/Host/升级护栏已落地；3080 单进程与图片链路完成真实验收；当前提交 `60f5afd` 已登记为 UI 基线 | `danger-full-access` 与全文会话搜索仍是 warning |
| Phase 1 | TaskSpec、TaskNode、EvidenceRecord、ContinuationCapsule、TaskGraph、CAS、checkpoint/resume 已实现并通过 11/11 focused tests | 未在现有 UI 增加任务图；这是本轮“UI 零改动”约束下的主动保留项 |
| Phase 2 | Compaction v2、结构化 verifier/repair、capsule store、memory candidate 已启用；直接样本、真实 `/compact`、自动 pressure、多轮有界收敛和压缩后续写通过 | 长期自然负载 soak 为可选后续，不阻断本轮验收 |
| Phase 3 | Memory v2、FTS5、scope/provenance/time/status、candidate 审核、跨会话 project identity 与关系投影已接入正式 Web；隔离实机完成 memory dry-run/cross-session 工具调用；20 个记忆生命周期和 20 个跨会话样本通过，Recall@2=1、scope leak=0 | 尚未跑 LongMemEval、LoCoMo、MemoryAgentBench；background consolidator 仍是后续增强 |
| Phase 4 | 增量代码索引、repo map、候选查询和 test-impact 候选已实现 | 首版使用保守解析器；tree-sitter/SCIP 和 SWE-bench canary 尚未完成 |
| Phase 5 | Design/QA manifest、PNG diff、功能/视觉/a11y 分层 Gate 已实现 | 没有改当前 UI；DesignBench、Interaction2Code 和多 viewport 正式基线尚未完成 |
| Phase 6 | ADR、架构 fitness、Host/UI seam 检查与升级合同已落地 | dependency-cruiser/C4 和项目级性能预算仍待扩展 |
| Phase 7 | 六类离线 eval fixture、23 组回归、80 个直接样本、自动 pressure 与回滚演练已落地 | 外部 benchmark 和长期 shadow 按用户要求不作为本轮阻断项 |

本轮最新回归共 23 组，23 组全部通过。旧基线差异已追溯到提交 `60f5afd`（心跳恢复和 Git 工作区）；旧 manifest 保留为审计档案，当前已提交状态成为新的 22 文件保护基线，`dsh-git` 作为既有 Host/UI 兼容 seam 明确登记。没有修改这些 UI 文件。

`profiles/web-intelligence` 候选 profile 已完成 Loader、隔离启动、真实工具、重启和 Compaction v2 验收。通过后，同一组 Host-only bundles 已接入默认 `web`；正式 3080 中 DeepSeek 真实调用 `intelligence_contract_validate` 成功。候选 3081 已关闭并保留为后续升级 staging profile。

## 一、先给结论

DeepSeek Harness 现在的问题，不是能力太少，而是已有能力没有组成一套可靠、可恢复、可评测的系统。

本机已经具备追加式 Session Event Log、自动上下文压缩、Plan Mode、Goal、Todo、Subagent、Workflow、文件与终端工具、浏览器、截图、识图和前端 QA 技能。真正缺少的是统一的任务状态、上下文装配、长期记忆、跨会话关系、代码图谱、视觉验收和架构约束。

因此，推荐路线不是替换 Harness 内核，也不是把 Letta、LangGraph、OpenHands 或 Cline 整体搬进来。应继续使用 DeepSeek Harness 的 Cordis 插件架构和事件日志，在官方扩展点上新增七个可替换模块：

1. 上下文经纪人：决定每轮模型真正需要看到什么。
2. 任务图：把目标、计划、依赖、进度、证据和回滚点变成持久状态。
3. 记忆 v2：把词法 Markdown 召回升级为有来源、有时间、有版本的本地记忆库。
4. 跨会话解析器：把 session、task、project、branch、artifact 和 decision 关联起来。
5. 代码智能：用代码地图、AST、引用关系和测试影响分析选择最小代码上下文。
6. 前端视觉验收：把截图、DOM、交互、控制台、网络、无障碍和多尺寸检查纳入同一验收。
7. 架构守卫与评测中心：把 ADR、依赖规则、质量门和长期对照实验变成可执行规则。

推荐原则：**原始事实永不因压缩删除；模型上下文只是按任务生成的临时视图；任何“能力提升”都必须用可复现实验来证明。**

## 二、本机现状：已经有什么，真正缺什么

### 2.1 已经具备的底座

| 能力 | 当前实现 | 已验证状态 | 结论 |
|---|---|---|---|
| Session 真源 | 追加式 Session Event Log、JSONL 持久化、projection、resume/fork | 已从 rc.8 安装包源码核实 | 应继续作为全系统事实总账 |
| 上下文压缩 | token 压力触发、overflow 恢复、工具结果裁剪、LLM 摘要、durable compaction 事件 | 56 个 session 中有 118 次 prune、3 次 durable summary | 能工作，但样本不足，且与长期记忆脱节 |
| 计划与目标 | Plan Mode、Goal、Todo 都是事件溯源状态 | 已从官方包源码核实 | 不应重写；应在其上补 TaskGraph 和证据合同 |
| 多 Agent | spawn/fork、continuable child、workflow、固定 execute_flash | 已挂入 reliable-development preset | 机制够用；不需要再引入一套 Agent 框架 |
| 长期记忆 | `memory_save/recall/checkpoint/get/list/search`，Markdown 文件 | focused test 1/1 通过 | 只有手动词法召回，距离可靠长期记忆仍远 |
| 跨会话 | `dsh-session-reference` 显式引用会话 | 源码已核实 | 只能手动引用；没有自动关系发现和工作区级召回 |
| 代码开发 | bash、fs、rg、精确编辑、Git、GitHub、worker-thread runtime | 已挂载 | 缺仓库地图、符号/引用图和测试影响选择 |
| 前端能力 | 浏览器、截图/OCR、Playwright MCP、Figma/前端技能、视觉 QA 规则 | 13 个本地 focused tests 通过 | 规则和工具都有，但没有统一的视觉反馈循环和评测库 |
| 架构能力 | goal-first、SOP、J-Space、计划模式 | 已安装并部分验证 | 主要是提示词和技能，缺可执行架构约束与漂移检查 |

### 2.2 当前必须先解决的 P0 问题

1. **版本合同漂移。** 正式安装已是 `@deepseek-ai/dsh@0.1.0-rc.8`，但 `container.manifest.yaml`、`bin/dsh`、`scripts/doctor`、`scripts/restore` 仍残留 rc.6；本地扩展依赖也存在 rc.6/rc.8 混用。
2. **真实运行验收缺失。** 当前 3080 未监听；日志近期出现过 `EADDRINUSE` 和插件依赖解析失败。本轮只读审计没有重新完成启动、控制台和浏览器链路验收。
3. **默认权限过宽。** 大多数 session 使用 `danger-full-access + approval=never`，与“可靠开发”宣称的谨慎操作不一致。
4. **压缩与记忆分裂。** compaction 会生成 durable summary，但不会自动沉淀为跨会话记忆；memory 也不会从 session 事件中自动提炼。
5. **跨会话搜索关闭。** `session-query-sqlite` 当前是 `path: ':memory:'; openAt: never`，全文会话搜索未启用。
6. **校验器会崩溃。** `reliable-development-evolution/SKILL.md` 缺 YAML frontmatter；`skill-check.mjs` 在错误分支仍读取 `fm.name`。手工安全校验为 47/48，通过脚本本身却无法完整报告。
7. **本地改造来源分散。** 修改分布在本地 extensions、profile patch、安装包 bundle 和备份中。上游升级时容易被覆盖，也难以判断哪一份是正式来源。

### 2.3 当前量化基线

本机 `session-audit.mjs` 读取到 56 个 session：

- 284 turns；
- 11,734 次 tool call；
- 218 次 tool failure，约占 1.9%；
- 51 次 rework 记录；
- 36 个 cordis session，20 个 reliable-development session。

这些数字只说明“当前已有可观察数据”，不能直接证明质量。后续必须先统一事件口径，再用同一批任务做开关对照。

## 三、GitHub 与官方实践：该借什么，不该搬什么

| 来源 | 值得借鉴的机制 | 在 Harness 中的落点 | 不直接采用的原因 |
|---|---|---|---|
| [DeepSeek Harness 官方架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) | 所有能力都是插件；Session Event 是真源；模型可见内容必须可从日志重建 | 使用 `session/event`、`agent/pre-step`、`tools/*`、`ctx.sessions` 等正式扩展点 | 官方仍是 developer preview，不能继续依赖无回归保护的深层 bundle patch |
| [OpenHands Condenser](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/context/condenser/base.py) | 完整事件与模型 View 分离；压缩策略可串联；压缩结果也是事件 | ContextViewBuilder、可插拔 CompactionStrategy | 不整体引入 Python runtime |
| [Gemini CLI chatCompressionService](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/context/chatCompressionService.ts) | 安全切分、工具输出落盘指针、独立压缩模型、摘要后验证、失败锁存 | Compaction v2 的直接实现参考 | 增量 cluster 压缩仍是实验，不作为首期正式方案 |
| [Codex compaction](https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/compact.rs) | 压缩是一等事件和 trace；保留 hook；替换后重算 tokens | checkpoint 事件、遥测、CAS/version | 公开问题显示重复工作、并发覆盖和缓存失效仍需防护 |
| [Codex memory pipeline](https://github.com/openai/codex/blob/main/codex-rs/memories/README.md) | Phase 1 按会话抽取，Phase 2 串行整合；渐进披露；原始摘要与高层记忆分层 | Memory Writer、Consolidator、memory summary/index | 要修正全局 scope、并发重复和记忆可管理性问题 |
| [Letta Code / MemFS](https://github.com/letta-ai/letta-code) | 核心索引小、详情按需、Git 版本化、后台 dreaming、memory doctor | 人类可检查的记忆目录、后台整合、记忆体检 | 生命周期和 runtime 过重，不直接 fork |
| [Graphiti](https://github.com/getzep/graphiti) | episode、时间有效性、来源、冲突不覆盖历史、混合召回 | MemoryRecord 的时态与 provenance | 首期不部署 Neo4j/FalkorDB；先用 SQLite |
| [LangGraph persistence](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx) | checkpointer 管 thread，store 管跨 thread；节点级 durable writes | RunCheckpoint 与 Project/User Store 分离 | 不引入另一套工作流 runtime |
| [Aider repo map](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/repomap.md) | 用符号和依赖图生成 token-bounded 仓库地图 | CodeContextBroker | 不复制整套 Python 产品 |
| [Aider architect/editor](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/usage/modes.md) | 方案模型与编辑模型分工 | V4 Pro 规划、V4 Flash 执行 | 简单任务不值得双调用 |
| [Continue indexing](https://github.com/continuedev/continue/blob/main/core/indexing/README.md) | content hash 增量索引；tree-sitter、FTS5、向量索引分层 | 本地代码索引、branch/worktree 隔离 | IDE 产品过重，只借索引合同 |
| [SWE-agent ACI](https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md) | 简洁工具输出、编辑时语法 Gate、专用搜索和文件窗口 | 工具结果控制、patch 前校验 | bash-only 不能覆盖全部任务 |
| [Cline Plan/Act](https://github.com/cline/cline/blob/main/docs/core-workflows/plan-and-act.mdx) | 计划与执行权限真正分离、执行前 checkpoint | ModePolicy、ToolPolicy | 不直接嵌入其完整 IDE/CLI |
| [GitHub Spec Kit](https://github.com/github/spec-kit) / [OpenSpec](https://github.com/Fission-AI/OpenSpec) | spec→plan→tasks→implement→converge；brownfield change delta | 复杂变更的 TaskSpec 和收敛检查 | 小任务不能强制文档流水线 |
| [screenshot-to-code](https://github.com/abi/screenshot-to-code) | 视觉参考→多前端栈初稿 | 可替换生成 sidecar | 生成结果不能直接视为交付 |
| [Playwright](https://playwright.dev/docs/test-snapshots) | screenshot diff、trace、DOM、console、network | 前端 QA Gate | 单一 pixel diff 也不能替代人工视觉判断 |
| [BrowserGym](https://github.com/ServiceNow/BrowserGym) / [WebArena](https://github.com/web-arena-x/webarena) | 可编程浏览器任务 verifier | 浏览器能力离线评测 | 研究环境，不嵌入正式运行时 |
| [Structurizr](https://github.com/structurizr/structurizr) / [ADR](https://github.com/joelparkerhenderson/architecture-decision-record) | 架构即代码、决策与后果留痕 | ArchitectureRecord、C4、ADR | 图和文档必须由可执行规则验证 |
| [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) | 禁止依赖、循环、孤儿模块和结构报告 | Architecture Fitness Functions | 先覆盖 JS/TS，其他语言按项目扩展 |

### 调研后的取舍

- **采用机制，不替换内核。** Node/TypeScript + Cordis 继续是主线；Python 工具只通过 MCP、CLI 或 sidecar 接入。
- **SQLite 先行。** 第一版使用 SQLite WAL、FTS5、结构化表和本地 embedding；只有评测证明多跳图检索确有收益，才接 Graphiti。
- **一个父 Agent 默认负责。** 专业子 Agent 只接受边界明确的任务。不要把多角色数量当能力。
- **结构化状态优先。** Markdown 用于人看；内部状态一律通过 JSON Schema/Zod 校验。
- **原始事件不可变。** compaction、memory、handoff 都是派生层，可重建、可比较、可回滚。

## 四、目标架构

```text
用户输入 / 图片 / 文件 / 会话引用
              │
              ▼
      Intake + TaskSpec
              │
              ▼
    Goal + PlanGraph + ModePolicy
              │
              ▼
         Context Broker
   ┌──────────┼──────────┐
   │          │          │
热上下文   温上下文    冷存储
近期消息   checkpoint  完整 Session Event
当前任务   项目记忆    原始工具结果/Artifact
核心约束   代码地图    全量历史与索引
   └──────────┼──────────┘
              ▼
         Model Router
  规划/架构模型     执行/整理模型
              │
              ▼
       Tool Policy Engine
  allow / ask / deny / sandbox / worktree
              │
              ▼
   Runtime / Browser / Subagent / MCP
              │
              ▼
 Session Events + Artifacts + Evidence
      │             │             │
      ▼             ▼             ▼
 Compactor     Memory Writer   Eval Center
      │             │             │
      └───────可重建派生状态───────┘
```

### 4.1 与官方架构的关系

官方文档明确规定：Session Event Log 是模型历史、fork、resume、transcript、telemetry 和 persistence 的共同真源；任何模型可见输入都应能从日志重建。

因此，新增能力应采用插件和事件投影：

- 上下文组装：监听 `agent/pre-step`；
- 任务、checkpoint、memory candidate：新增 durable Session Event；
- 工具权限和证据：监听 `tools/pre-execute`、`tools/post-execute`；
- 压缩：复用 `ctx.compaction` 和现有 token meter；
- 跨会话：复用 `ctx.sessions`、session query、projection cache 和 session reference；
- UI：从 durable event/projection 渲染，不维护第二份隐式状态。

不建议直接改 agent loop。也不建议把正式功能只写进 persona 或单个 Skill。

## 五、七个核心模块

### 5.1 Context Broker：上下文不再等于聊天记录

每轮请求只装配四类信息：

1. 固定核心：安全规则、当前模式、用户锁定约束。
2. 任务核心：Goal、当前 PlanNode、输入输出合同、未解决风险。
3. 按需事实：相关记忆、代码符号、ADR、Artifact、过往 session 片段。
4. 近期原文：最近完整消息和仍未结算的 tool call/result。

建议接口：

```ts
interface ContextRequest {
  sessionId: string
  taskId?: string
  projectId: string
  modelTarget: { provider: string; model: string }
  tokenBudget: number
  query: string
  mode: 'plan' | 'act' | 'debug' | 'review' | 'architect'
}

interface ContextBundle {
  sections: ContextSection[]
  sourceEventIds: string[]
  memoryIds: string[]
  artifactRefs: string[]
  estimatedTokens: number
  omitted: OmissionRecord[]
}
```

装配顺序必须可观察：为什么召回、为什么排除、用了多少 tokens、是否含不可信外部内容，都要进入 trace。

### 5.2 Compaction v2：先裁剪，再提炼，再验证

现有 compaction-basic 保留。新增策略作为可插拔 provider，不另写第二套 agent loop。

推荐流程：

```text
测量 token 压力
  → 安全边界检查
  → 大工具输出移出上下文，保留摘要和 Artifact 指针
  → 生成 ContinuationCapsule（结构化）
  → 生成可读摘要
  → 校验路径、数字、约束、任务、工具配对和摘要体积
  → CAS/version 提交 compaction 事件
  → 重算 active view tokens
```

首期参数建议从实验开始，不直接锁死：

- 自动触发：模型窗口的 0.55–0.70；
- 保留 head + tail：20%–30%；
- V4 Pro/Flash 使用独立 `compression` 模型别名；
- summarizer 最大重试 1 次；失败后本轮只做安全裁剪，不反复请求模型；
- 工具调用与结果不能被拆开；
- 压缩后体积不降或摘要为空，拒绝替换。

`ContinuationCapsule` 至少包含：

```json
{
  "schemaVersion": 1,
  "goal": {},
  "protectedConstraints": [],
  "planSnapshot": {},
  "activeTask": {},
  "decisions": [],
  "touchedFiles": [],
  "gitState": {},
  "testsAndEvidence": [],
  "errorsAndAttempts": [],
  "artifacts": [],
  "pendingJobs": [],
  "nextAction": {},
  "sourceEventIds": []
}
```

最重要的改动是：后续再次压缩时，应从原始事件、Artifact 和最新 capsule 重建，不只对旧摘要继续摘要。这样才能避免多轮压缩逐步丢失事实。

### 5.3 Memory v2：本地、分层、可解释

推荐五层记忆：

| 层级 | 内容 | 注入方式 |
|---|---|---|
| L0 原始事件 | 完整 Session Event、工具调用、结果、附件引用 | 默认不注入，只在追溯时读取 |
| L1 工作记忆 | 当前任务、近期原文、未结算动作 | 每轮按预算注入 |
| L2 情节记忆 | 某次任务做了什么、失败在哪里、结果如何 | 任务相关时召回 |
| L3 语义记忆 | 用户偏好、项目事实、约束、术语、稳定决策 | 按 scope 和查询召回 |
| L4 程序记忆 | 经测试或评审的 Skill、规则、操作手册 | 触发对应任务后加载 |

第一版存储：

- SQLite WAL：结构化记录、事务、并发和版本；
- FTS5：关键词/BM25；
- 本地 embedding：优先复用现有 `embeddinggemma`，作为可关闭选项；
- 文件系统：存放大 Artifact 和人类可读的 Markdown；
- Git：只版本化经过整合的可读记忆，不把原始 session 和敏感内容推到远端。

核心数据合同：

```ts
interface MemoryRecord {
  id: string
  scope: { type: 'user' | 'project' | 'task' | 'agent'; id: string }
  kind: 'preference' | 'fact' | 'decision' | 'episode' | 'procedure' | 'failure'
  content: string
  sourceSessionId: string
  sourceEventIds: string[]
  observedAt: string
  validFrom?: string
  validTo?: string
  status: 'candidate' | 'active' | 'superseded' | 'disputed' | 'expired'
  confidence: number
  sensitivity: 'normal' | 'restricted' | 'secret'
  contentHash: string
  supersedes?: string[]
}
```

写入分两段：

1. 热路径只记录 event 和少量 candidate，不阻塞用户响应。
2. 后台 consolidator 执行提取、去重、冲突识别、时态更新、来源绑定和敏感信息检查。

召回使用混合排序：FTS/BM25 + embedding + entity/link + freshness + task relevance。第一阶段可用 Reciprocal Rank Fusion，避免只靠向量。

每次只注入 2–8 个 memory capsule，并附 `memory_id`、时间、来源、置信度和“不可信内容”标签。

### 5.4 CrossSessionResolver：把会话变成任务历史

跨会话关联不能只靠标题和 cwd。建议建立稳定身份：

- `user_id`：本机用户或显式账户；
- `project_id`：规范化路径 + Git remote/repo identity；无 remote 时使用人工 project key；
- `workspace_id`：具体 checkout/worktree；
- `task_id` / `goal_id`：跨 session 保持；
- `session_id`：一次会话；
- `branch` / `commit`：代码状态；
- `artifact_id` / `decision_id`：产物和决定。

关系边示例：

```text
SESSION continues TASK
SESSION forks SESSION
TASK belongs_to PROJECT
TASK depends_on TASK
TASK produces ARTIFACT
DECISION constrains TASK
MEMORY derived_from SESSION_EVENT
CHECKPOINT resumes_at PLAN_NODE
```

新会话启动时：

1. 识别 project/workspace/task；
2. 读取小型 project index；
3. 找到 1–3 个最相关的 continuation capsule；
4. 验证可能漂移的 repo/runtime 事实；
5. 展示“我将从哪里继续”，再进入第一个动作。

同时提供 `/memory` 和 `/sessions` 管理界面：查看来源、解释召回、修改、固定、归档、遗忘、重建索引。删除和批量整理默认 dry-run，并先备份。

### 5.5 TaskGraph：计划必须是状态，不只是一段文字

现有 Plan Mode、Goal、Todo 继续保留。新增 TaskGraph 把它们统一成可恢复的执行合同。

```ts
interface TaskNode {
  id: string
  goalId: string
  parentId?: string
  title: string
  status: 'pending' | 'in_progress' | 'blocked' | 'done' | 'rolled_back'
  owner: string
  dependencies: string[]
  inputRefs: string[]
  outputContract: object
  mutationScope: string[]
  toolPolicy: object
  validationContract: object
  rollbackRef?: string
  evidenceRefs: string[]
  replanReason?: string
}
```

规划规则：

- 简单任务不强制进入复杂图；
- 多子系统任务先发现、再定方案、再执行；
- 计划节点必须写输入、输出、依赖、权限、验证和回滚；
- 并行只用于无冲突的只读发现或明确分区的实现；
- 同一文件或合同同一时间只有一个 mutation owner；
- 计划变化必须记录原因和影响范围；
- `done` 必须有 evidence，不接受模型自报完成。

模式建议：

- `plan`：只读发现和方案；
- `architect`：架构方案、ADR、约束与影响分析；
- `act`：按已确认节点执行；
- `debug`：复现、假设、单变量实验；
- `review`：只读审计、反例和验收。

ToolPolicy 要真正控制工具，不只改 system prompt。涉及写文件、Git、外部系统和危险 shell 的能力，要按模式配置 `allow/ask/deny`。

### 5.6 Code Intelligence：让模型看到相关代码，不是更多代码

建议三层索引：

1. tree-sitter：增量 AST、符号、函数、类、import/export；
2. FTS5 + rg：精确字符串、错误和配置；
3. SCIP/LSP：definition、reference、implementation、调用关系。

索引按 `project_id + branch/worktree + content hash` 隔离。文件没有变化就不重算。

每次编码上下文按以下顺序选择：

```text
任务关键词
→ 仓库地图
→ 相关符号子图
→ 入口与调用者
→ 目标文件精确窗口
→ 相邻测试和失败日志
→ Git diff 与用户未提交修改
```

编码执行采用两种路线：

- 小任务：单模型完成理解、patch 和 focused test；
- 复杂任务：V4 Pro 负责架构和任务合同，V4 Flash 只执行明确文件范围，父 Agent 复核 diff 和测试。

patch 在落地前做 schema/语法检查；落地后分层验证：syntax/static → focused test → relevant regression → real runtime/browser。任何一层都不能替代下一层。

### 5.7 Frontend + Architecture：把审美和设计约束变成证据

#### 前端设计

前端任务先生成 `DesignSystemManifest`：字体、层级、间距、圆角、颜色角色、阴影、图标、breakpoint、主题和动效。设计真源来自现有页面、Figma、截图或用户明确要求，不能凭模型另起视觉体系。

执行循环：

```text
用户任务 / Figma / 截图
→ 用户路径与页面状态
→ DesignSystemManifest
→ 组件/页面代码
→ 本地运行
→ Playwright 交互与截图
→ DOM/ARIA/console/network/trace
→ 视觉模型或人工结构化评审
→ 小范围修复
→ 再验收
```

最终 `DesignQAManifest` 至少包含：

```json
{
  "viewports": [],
  "themes": [],
  "states": [],
  "screenshots": [],
  "visualDiffs": [],
  "consoleErrors": 0,
  "networkFailures": 0,
  "accessibility": {},
  "interactionChecks": [],
  "tracePath": "",
  "verdict": "pass"
}
```

#### 架构设计

复杂改造先产生四类正式产物：

```text
spec.md                 要解决什么、什么不做、验收是什么
plan.md                 技术方案、数据流、迁移与失败处理
tasks.md                可执行节点、依赖、负责人、验证和回滚
docs/architecture/
  workspace.dsl         C4 模型
  decisions/ADR-*.md    决策、选项、后果、替代方案
  fitness-functions.*   可执行架构规则
```

架构质量不能靠文档自洽。至少要执行：

- 禁止依赖和分层规则；
- 循环依赖与孤儿模块；
- API/JSON Schema 合同测试；
- 数据迁移前后兼容；
- 关键性能预算；
- 安全与权限边界；
- 代码、架构图、ADR 和实际运行的漂移检查。

## 六、实施路线

### Phase 0：基线、版本和安全（1–2 周）

**目标**：先把当前系统变成可重复升级、可完整检查的状态。

交付：

- 统一 rc.8 版本合同；
- 建立本地改造 manifest：正式源、生成物、第三方 patch、备份、重放顺序；
- 修复 `skill-check` 崩溃和缺 frontmatter；
- 统一扩展依赖版本；
- 按任务模式收紧 ToolPolicy；
- 重新完成单进程启动、页面、控制台、插件、浏览器和模型链路验收；
- 固化 56 个历史 session 的指标口径和首批回放样本。

Gate：

- doctor、skill-check、preset validation 不崩溃；
- 3080 单进程；
- 页面可打开，控制台无新错误；
- 关键插件可用；
- 版本清单与实际安装一致；
- 没有清理或覆盖用户现有 dirty changes。

回滚：保留当前配置、patch、扩展和启动脚本快照；任何升级失败都回到当前 rc.8 可恢复基线。

### Phase 1：TaskGraph 与统一事件合同（2–3 周）

**目标**：先规定任务、证据和恢复状态，给压缩与记忆提供稳定数据。

交付：

- TaskSpec、TaskNode、EvidenceRecord、ContinuationCapsule JSON Schema；
- Goal/Plan/Todo 的统一 projection；
- plan/act/debug/review/architect 的真实权限；
- 任务、checkpoint、evidence 的 durable events；
- UI 中的任务图、进度、证据和回滚点。

Gate：20 个中断/重启/恢复样本中，当前任务、下一步、未完成节点和证据 100% 可重建。

### Phase 2：Context Broker 与 Compaction v2（2–4 周）

**目标**：长会话能持续工作，多次压缩不重复劳动、不丢关键事实。

交付：

- ContextViewBuilder；
- 大工具输出 Artifact 化；
- safe boundary 和 head/tail 策略；
- 结构化 capsule + 可读摘要；
- verifier、CAS/version、失败锁存和裁剪回退；
- 压缩 trace 与成本统计。

Gate（先以内部样本校准，再冻结）：

- 关键路径、数字、用户约束、待办、测试结果保留率 ≥98%；
- tool call/result 配对破坏 0 次；
- 空摘要/膨胀摘要 0 次落地；
- 压缩后继续任务成功率 ≥90%；
- 多轮压缩导致重复修改率相对当前基线下降 ≥50%；
- 原始事件零丢失。

### Phase 3：Memory v2 与跨会话关联（3–5 周）

**目标**：新会话能找到正确项目、任务、决定和证据，同时能识别旧事实已经失效。

交付：

- SQLite/FTS5/optional embedding 存储；
- memory candidate、background consolidator、冲突与时态版本；
- project/task/session/artifact/decision 关系；
- JIT recall 与 provenance；
- `/memory`、`/sessions` 检查和管理；
- secret、路径穿越、memory poisoning、跨 scope 泄漏防护。

Gate：

- 内部跨会话集 Recall@5 ≥90%，MRR ≥0.80；
- session/task 关联准确率 ≥95%；
- 旧事实误用率 ≤2%；
- secret 写入 0；
- 崩溃恢复后数据库与文件索引一致；
- LongMemEval、LoCoMo、MemoryAgentBench 跑出可复现基线，不引用厂商托管分数代替本机结果。

### Phase 4：代码智能与可靠开发（4–6 周）

**目标**：减少无关读取和修改，提高一次定位、一次 patch 和验证质量。

交付：

- content-addressed repo index；
- tree-sitter/FTS5/SCIP 代码图；
- token-bounded repo map；
- test impact selection；
- architect/editor 路线；
- worktree/sandbox；
- patch、测试、artifact 和证据 registry。

Gate：

- 现有 5 类 reliable-development 任务连续 3 轮 ≥80 分；
- 无伪造测试、文件、来源或完成声明；
- 无关文件修改中位数为 0；
- internal coding suite 一次成功率相对 Phase 0 提升 ≥20%；
- 长任务 input tokens 相对同任务全历史方案下降 ≥30%，任务成功率不下降；
- 先运行 20–50 个 SWE-bench Verified canary，再决定是否扩大。

### Phase 5：前端视觉能力（3–5 周）

**目标**：前端能力从“会写页面”升级为“能按设计真源实现并用真实页面验收”。

交付：

- DesignSystemManifest；
- Figma/截图/现有页面真源接入；
- Playwright trace、截图基线、visual diff、console/network/a11y；
- 视觉评审结构化输出；
- 20–50 个内部页面/交互任务；
- DesignBench、Interaction2Code 的离线适配。

Gate：

- 内部视觉评测 ≥85/100；
- 阻断级视觉缺陷 0；
- 关键交互 100% 通过；
- 规定 viewport/theme/state 覆盖 100%；
- 控制台错误和失败网络请求为 0；
- 连续 3 轮不得伪造截图或视觉验收。

### Phase 6：架构设计与约束（3–4 周）

**目标**：架构建议能够追溯到需求，并由代码检查证明没有偏离。

交付：

- spec/change/plan/tasks/ADR/C4 模板；
- dependency-cruiser 与项目定制规则；
- schema、migration、performance、security fitness functions；
- architecture converge 检查；
- 架构变更影响分析和自动提醒。

Gate：

- 需求→决策→任务→代码→测试追溯覆盖 100%；
- 新增禁止依赖 0；
- 新增循环依赖 0；
- schema breaking change 无迁移方案 0；
- 复杂改造完成时 ADR、图、代码和测试无未解释漂移。

### Phase 7：持续评测与灰度（持续）

每项能力都通过 feature flag 灰度。顺序是离线回放→只读 shadow→少量真实任务→默认开启。任何关键指标退化，回滚到上一 provider 或关闭新策略，不回滚原始事件。

## 七、评测体系

### 7.1 统一指标

| 领域 | 核心指标 |
|---|---|
| 压缩 | before/after tokens、保真率、边界安全、压缩耗时、摘要膨胀、重复劳动、失败回退 |
| 记忆写入 | candidate 数、通过率、去重率、冲突率、来源完整率、secret 拦截、后台积压 |
| 记忆读取 | Recall@k、MRR、nDCG、时间/多跳/更新/弃答、误召回、false-memory rate |
| 跨会话 | 任务关联、恢复率、首次有效动作时间、重复探索、跨 scope 泄漏 |
| 规划 | schema 合法、依赖正确、计划变更次数、缺失验收、节点完成证据、恢复成功 |
| 代码 | patch pass、一次成功、平均修复轮数、无关修改、测试选择、token/时间/成本 |
| 前端 | 视觉差异、层级/间距/token 一致性、交互、DOM/ARIA、console/network、viewport/theme |
| 架构 | ADR 覆盖、禁止依赖、循环、schema 兼容、漂移、性能与安全规则 |

### 7.2 外部基准与内部基准的分工

- [LongMemEval](https://github.com/xiaowu0162/LongMemEval)：跨会话、时间、知识更新、弃答。
- [LoCoMo](https://github.com/snap-research/LoCoMo)：长对话、多 session、多跳。
- [MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench)：检索、现场学习、长程理解、冲突。
- [SWE-bench](https://github.com/SWE-bench/SWE-bench)：真实 GitHub issue 修复。
- Terminal-Bench：终端内完整工程任务。
- [DesignBench](https://github.com/webpai/designbench)：生成、编辑、修复，多前端框架。
- [Interaction2Code](https://github.com/WebPAI/Interaction2Code)：交互原型到代码。
- BrowserGym/WebArena：浏览器任务执行。

外部 benchmark 只用于横向比较。真正决定是否默认开启的，是本机真实项目的 held-out 任务、历史失败样本和连续三轮稳定结果。

## 八、安全、隐私和可恢复性

1. **网页、图片、仓库文档和历史记忆默认是不可信数据。** 它们不能改变用户指令、工具权限或系统规则。
2. **敏感内容不进入 embedding。** Token、密码、私钥、证件和私密业务数据在写 memory 前拦截或标为 restricted。
3. **每条记忆有 scope、来源和时间。** 不能把一个项目的结论注入另一个项目。
4. **模型不能静默改写程序记忆。** Skill、规则和高优先级 memory 必须有 diff、测试和人工或策略审批。
5. **Plan 模式真实只读。** 写文件、Git、外部系统和危险 shell 必须由 ToolPolicy 阻断。
6. **所有派生层可重建。** active view、FTS、embedding、图关系和 summary 损坏时，可从事件与 Artifact 重建。
7. **所有破坏性管理默认 dry-run。** 批量遗忘、归档、重索引、迁移前先备份和列出精确目标。

## 九、明确不做的事

- 不 fork 并长期维护一套新的 DeepSeek Harness 内核。
- 不把 Letta、LangGraph、OpenHands、AutoGen 或 MetaGPT 整体嵌入主进程。
- 不以多 Agent 数量衡量能力。
- 不把全部聊天、全部记忆、整个仓库或整个 DOM 塞进 prompt。
- 不采用 embedding-only 检索。
- 不允许模型直接 UPDATE/DELETE 原始事实。
- 不在首期部署图数据库。
- 不把 focused test、mock、截图或单次 benchmark 升格为生产就绪。
- 不在当前 dirty repo 上清理、reset、commit、push 或覆盖用户改动。

## 十、首个可交付版本（MVP）

如果希望尽快看到真实提升，首个版本只做四件事：

1. 统一 rc.8 版本、权限和启动验收；
2. 落地 TaskGraph、EvidenceRecord 和 ContinuationCapsule；
3. 将 compaction 升级为“安全裁剪 + capsule + verifier + fallback”；
4. 将 memory 升级为 SQLite/FTS5 + scope/provenance/time，并自动从 capsule 产生 candidate。

这个 MVP 不上图数据库，不做复杂 multi-agent，也不先做 UI 自动生成。它先解决长任务最容易失败的三个根因：状态只在模型脑中、摘要不可验证、跨会话只能靠人复述。

MVP 通过后，再进入代码图谱和前端视觉能力。顺序不能反过来。

## 十一、下一步实施顺序

首轮后端 MVP 已落地，下一步不再重复写蓝图，而是按证据逐级接入：

1. 保持 ToolPolicy 为 observe，先积累真实使用数据，不改变当前权限体验。
2. LongMemEval、LoCoMo、SWE-bench 和长期 soak 作为可选评分工作，不阻断本轮验收。
3. 任何上游升级按 ADR-0002 和 `architecture/upgrade-contract.json` 在 staging 环境执行，不能覆盖当前 rc.8 试错。
4. 使用已生成的 rc.8 增强离线包做回滚；恢复后必须重跑 UI、preset、Host 与模型工具 Gate。

## 十二、QA 结论与边界

### 已完成

- rc.8 版本合同、skill-check、doctor 和 Host 启动基线修复；
- TaskGraph、Compaction v2、Memory v2、跨会话、代码智能、前端 QA、Evals、ToolPolicy 的 Host-only 首版；
- 压缩成功后写 project-scoped memory candidate，以及 candidate 的 dry-run/确认/审计升级；
- DeepSeek 文本路线图片桥修复：递归处理用户图片和工具结果图片，不修改 frozen 历史，不把原图交给 `deepseek-v4-flash`；
- 原污染会话真实续写成功，直接图片上传由智谱视觉桥识别后成功回答；
- 23 组统一回归、80 个直接模块样本、隔离数据根、自动 pressure、Headless/Web 候选 Loader、正式 Web 激活、升级兼容合同和离线回滚 Gate。

### 保留边界

- ToolPolicy 暂处 observe；权限默认值与全文会话搜索仍保持原行为；
- 外部 benchmark 和长期 shadow 未执行，按用户要求不作为本轮阻断项；
- 当前结论是“小范围验收通过并可正式使用”，不是对所有未来负载的无限期生产保证。

因此，当前结论是“首轮 Host MVP、图片 P0、Compaction v2、正式 Web 激活、UI 保护和回滚机制已完成并验收通过”。

## 附录 A：本机证据定位

| 判断 | 本机证据 |
|---|---|
| 正式安装已为 rc.8 | `/Users/marcus/.dsh/install/package.json:13-15` |
| 容器清单仍残留 rc.6 | `/Users/marcus/.dsh/container.manifest.yaml:7-12` |
| 可靠开发的 V4/Gemma 压缩策略 | `/Users/marcus/.dsh/.agent-presets/reliable-development/agent.cordis.yml:180-205` |
| 自动 pressure/overflow compaction | `/Users/marcus/.dsh/install/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:771-901` |
| 当前 Markdown memory 和词法召回 | `/Users/marcus/.dsh/extensions/dsh-memory/index.js:1-291` |
| memory focused test | `/Users/marcus/.dsh/extensions/dsh-memory/index.test.mjs:7-43` |
| 跨会话显式引用与不可信快照边界 | `/Users/marcus/.dsh/install/node_modules/@deepseek-ai/dsh-session-reference/lib/index.js:306-506` |
| session 全文搜索默认关闭 | `/Users/marcus/.dsh/install/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:25-33` |
| Plan Mode 是事件记录的可恢复状态 | `/Users/marcus/.dsh/install/node_modules/@deepseek-ai/dsh-plan-mode/lib/index.js:8-24` |
| Goal/Todo/Subagent/Workflow 已挂入可靠开发 preset | `/Users/marcus/.dsh/.agent-presets/reliable-development/agent.cordis.yml:125-160,216-338` |
| 前端功能与视觉分层 QA 规则 | `/Users/marcus/.dsh/skills/consumer-frontend-excellence/SKILL.md:10-65` |
| session 指标采集器 | `/Users/marcus/.dsh/scripts/session-audit.mjs:1-153` |
| skill-check 的空 frontmatter 崩溃点 | `/Users/marcus/.dsh/scripts/skill-check.mjs:43-60,89-92` |

## 附录 B：来源使用说明

- 外部项目的活跃度、许可和功能均按 2026-08-20 现场页面核验；后续真正引入依赖前必须再次检查版本、许可证和安全公告。
- 厂商 README 中的 benchmark 数字只用来理解其评测方法，不作为本机 Harness 的完成证据。
- GitHub issue 和 discussion 用于识别失败模式或候选方向，不等同于已合并、已稳定的正式能力。
- 上游 DeepSeek Harness 处于 developer preview。每次升级都要先运行兼容检查和本地回放，不能只看版本号。

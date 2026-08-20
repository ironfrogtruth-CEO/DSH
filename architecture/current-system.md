# DeepSeek Harness 当前系统边界

本文档记录当前本地 Harness 的可验证边界。它是架构护栏的说明，不是运行时配置；运行时配置仍以 `container.manifest.yaml`、`profiles/web/package.json`、各 Host 扩展 `package.json` 和已安装依赖为准。

## 组成

| 层 | 当前职责 | 约束 |
| --- | --- | --- |
| 固定运行时 | `install/node_modules/@deepseek-ai/dsh`，版本合同为 `0.1.0-rc.8` | `container.manifest.yaml`、`install/package.json`、安装包版本必须一致 |
| Profile | `profiles/web/package.json` 及其 bundle 路径 | bundle 只从声明的 link、profile 依赖或固定 install 目录解析 |
| Host 扩展 | `extensions/*/index.js` 及工具实现 | 依赖的 `@deepseek-ai/dsh-*` 必须与 rc.8 对齐；新 Host 扩展不携带客户端/UI/CSS |
| UI 边界 | `apps/*.swift`、`extensions/**/client.js`、`custom-ui-patches` 中的前端资源 | 只记录和校验哈希，能力建设不得直接改动这些文件 |
| 数据与记忆 | sessions、storages、memories 等运行数据 | 原始事件追加写入；派生索引可以重建，不能反向覆盖真源 |

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

默认 `profiles/web` 已启用 `dsh-tool-policy`（observe）、`dsh-intelligence`、`dsh-memory`、`dsh-code-intelligence`、`dsh-cross-session`、`dsh-frontend-qa` 与 `dsh-evals`。可靠开发 preset 在隔离的 Agent realm 中使用 `dsh-compaction-v2`，并同时隔离 `compaction`、`toolResultPruner` 与 `dshCompactionV2`。这些模块没有 client/UI 半部，不自动把派生状态注入模型；所有管理和检索通过显式工具调用。

## 上游升级边界

当前正式回退基线是 `0.1.0-rc.8`。候选 Harness 必须安装到隔离目录，不能覆盖当前 `install/` 试错。UI manifest、浏览器交互、Host 扩展、图片桥、压缩、记忆、跨会话、任务图和数据恢复是同一组升级 Gate；全部通过后才允许切换正式入口。任何未批准的 UI 并行修改都必须单独审计，不能由升级流程自动写成新基线。

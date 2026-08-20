# ADR-0002：从 rc.8 升级时保护 App UI 与本地能力

- 状态：Accepted
- 日期：2026-08-20
- 基线版本：`@deepseek-ai/dsh@0.1.0-rc.8`
- 范围：上游 Harness 升级、App 壳、Web UI、本地 Host 扩展、数据与回滚

## 背景

当前 App UI、交互和本地能力并不只来自上游安装包，还包含 `apps/`、`custom-ui-patches/`、既有 Web bundle、本地 Host 扩展、profile 配置和运行数据。直接在现有 `install/` 上覆盖升级，会把“上游版本变化”和“本地能力是否仍然有效”混在一起。一旦失败，很难判断丢失了什么，也很难可靠回到 rc.8。

## 决策

### 1. 不在当前正式安装上原地试升级

候选版本必须先安装到隔离的 staging 根目录。当前 rc.8 的 `install/`、profile、扩展、UI 文件和数据目录保持只读。只有候选版本通过全部 Gate 后，才允许以可回滚的指针或目录切换方式启用；禁止先覆盖再修。

### 2. UI 与能力是两个同等重要的升级合同

UI 合同使用明确批准的 SHA-256 manifest 和浏览器截图验收，保护：

- `apps/*.swift`；
- `extensions/**/client.js`；
- `custom-ui-patches/` 中的前端资源；
- 首页、会话切换、输入、图片、设置和既有工具卡片交互。

能力合同保护：

- 图片先识别为文字，再进入 DeepSeek 文本模型；
- Compaction v2 和结构化 continuation capsule；
- Memory v2、候选审核、来源和时间版本；
- 跨会话关系、TaskGraph、代码索引、Tool Policy、前端 QA 和 Evals；
- append-only 原始事件、正式数据隔离和可重建派生索引。

上游能启动但本地能力缺失，不算升级成功；能力测试通过但 UI 或交互变化，也不算升级成功。

### 3. 本地改造只能通过可重放清单迁移

升级前生成兼容快照，至少记录：

- 当前和候选 Harness 版本；
- UI manifest 及截图基线；
- profile bundle、Host 扩展和依赖版本；
- 本地 patch 脚本及其适用版本；
- 数据 schema 版本、迁移是否可逆、备份位置；
- 回归命令、结果文件和失败原因。

禁止把 `install/node_modules` 中的偶然手改当作正式迁移来源。确需 patch 时，必须有独立脚本、适用版本判断、幂等测试和撤销说明；上游已经提供相同能力时，应删除候选环境中的旧 patch，而不是叠加改写。

### 4. 升级按六道 Gate 逐级放行

1. **预检 Gate**：rc.8 版本合同、工作区状态、UI 基线、磁盘和备份位置明确。
2. **静态兼容 Gate**：候选包导入成功；Host 依赖与候选版本对齐；公开 seam 仍存在；没有新增核心 fork。
3. **能力 Gate**：运行 `run-intelligence-regression.mjs`，并对图片路由、压缩、记忆、跨会话和任务图做重点测试。
4. **数据 Gate**：只对备份副本执行 schema 迁移；原始 session/event 不丢失；派生索引可重建；回退后 rc.8 仍能读取原数据。
5. **UI Gate**：批准的 UI manifest 零差异；浏览器按固定 viewport 做截图和交互验收。未批准的并行 UI 变化不能自动成为新基线。
6. **现场 Gate**：在候选端口真实启动，完成文本、图片、工具结果图片、会话续写、重启恢复和错误回退。全部通过后才切换正式入口。

### 5. 失败默认回到 rc.8

任一 Gate 失败即阻断切换。失败处理只允许：修候选环境、更新兼容适配器、或放弃本次升级。正式 rc.8 目录和数据不变；若已经切换入口，则先切回 rc.8，再处理候选版本。回滚不能依赖重新联网下载旧包。

## 版本适配规则

- `architecture/upgrade-contract.json` 是机器可读合同；升级前必须更新 `candidateVersion`，但不能改写 `baselineVersion`。
- `scripts/patch-llm-image-downcast.mjs` 只服务 rc.7 及更早版本；rc.8 及以后通过 Host 图片桥处理，不能继续叠加旧 adapter patch。
- profile 与 Host 扩展依赖不得跨 rc 混用。候选环境应重新安装对应版本，不复制现有 `node_modules`。
- 数据迁移必须有 forward、verify、rollback 三个步骤；缺少 rollback 时只能在数据副本上试验，不能切换正式数据。

## 后果

升级会多一次隔离安装和回归时间，但正式 App 不再承担试错成本。每次升级都能回答四个问题：UI 是否变化、能力是否还在、数据是否可恢复、失败能否立即回到 rc.8。

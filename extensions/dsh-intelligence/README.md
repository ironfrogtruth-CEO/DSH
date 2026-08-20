# dsh-intelligence

`dsh-intelligence` 是 DeepSeek Harness 的 Host-only 基础库，第一版只负责可恢复的任务状态和显式上下文装配。它没有 `client.js`，不读取或改写现有前端 UI，不订阅 agent loop / compaction hook，也不会自动把记忆注入模型。

## 公开接口

- `schemas.js`
  - `JSON_SCHEMAS`：`TaskSpec`、`TaskNode`、`EvidenceRecord`、`ContinuationCapsule`、`ContextRequest`、`ContextBundle`、`OmissionRecord`。
  - `validate(name, value)`、`assertValid(name, value)`、`isValid(name, value)`。
  - `validateContinuationCapsule(value)`：ContinuationCapsule 的稳定快捷校验接口。
- `task-graph.js`
  - `TaskGraph` / `TaskGraphStore`：追加式事件、projection、revision/CAS、project scope。
  - `create`、`update`、`checkpoint`、`resume`、`get`、`list`、`events`。
  - `backend: "sqlite"` 使用 Node 22 内置 SQLite + WAL；`backend: "jsonl"` 使用追加式 JSONL；默认 `auto` 优先 SQLite，旧 Node 自动回退 JSONL。
- `context-bundle.js`
  - `assembleContextBundle(request, sources)` / `buildContextBundle`：纯函数、显式来源、token budget、provenance、omission 和 untrusted 标记。
- `index.js`
  - Host 插件只注册显式调用工具：`intelligence_task_create`、`intelligence_task_update`、`intelligence_task_checkpoint`、`intelligence_task_resume`、`intelligence_task_list`、`intelligence_context_bundle`、`intelligence_contract_validate`。

## 存储合同

原始事件只追加，不因 projection、压缩或恢复而删除。每个 task 必须带 `projectId`；读取和写入都需要显式 project scope，跨项目读取返回 `PROJECT_SCOPE_MISMATCH`。更新、检查点和恢复都递增 revision；传入旧 `expectedRevision` 返回 `CAS_CONFLICT`，不会覆盖新状态。

`TaskGraph.close()` 会等待内部写队列和 SQLite/JSONL 持久化完成，再安全关闭句柄；未打开实例的 close 是无副作用幂等操作，重复 close 也安全。close 后再次调用 `open` 或任意读写方法会安全重新打开后端。

任务进入 `done` 前必须至少有一条 `EvidenceRecord`，否则返回 `DONE_REQUIRES_EVIDENCE`。`ContinuationCapsule` 是可读的恢复快照，不是原始事件的替代品。

## 上下文合同

`assembleContextBundle` 只处理调用者显式传入的候选来源。受保护约束优先保留，即使它们使总 token 估算超过预算也不会被丢弃或截断；非受保护内容按优先级装配，超预算时截断或写入 `OmissionRecord`。每个 section 保留 `sourceEventIds`、`memoryIds`、`artifactRefs`，外部或未核验内容使用 `untrusted: true` 和 bundle 级 `untrustedSourceIds` 标记。

## 激活边界

`cordis.patch.yml` 只描述可选 bundle patch；本轮不修改 profile。只有 profile 明确加入该 bundle 后才会注册 Host 工具。即使激活，工具仍需由模型/调用者显式调用；插件没有 UI 半部，也不改变当前前端交互。

## focused test

```bash
npm test
```

测试覆盖：JSONL 重启恢复、SQLite（Node 22 可用时）、CAS 冲突、done 无 evidence 拒绝、预算裁剪保留 protected constraints、project 隔离，以及合同校验。

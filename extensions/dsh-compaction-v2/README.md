# dsh-compaction-v2

`dsh-compaction-v2` 是一个 Host-only、可选启用的 rc.8 compaction-basic 子类。它只扩展摘要载荷和成功事件后的 capsule 持久化，不复制 agent loop，也不替换 rc.8 已经验证的 range safety、tool-call/result pairing、token meter、overflow recovery、manual compact 和 durable compaction event 事务。

## 做了什么

1. `DshCompactionV2Engine` 继承 `@deepseek-ai/dsh-compaction-basic`。
2. `summarize()` 先调用 `super.summarize()`，再从上游结构化摘要和输入消息中提取有限的：
   - goal
   - protected constraints / anchors
   - touched files
   - errors and attempts
   - pending jobs
   - current work
   - next action
   - 数字、路径和命令片段
3. 提取结果用 `dsh-intelligence` 的 `validateContinuationCapsule` 校验；摘要为空、超过上限、capsule 非法或追加后膨胀时直接 fail closed，让父类 compaction 失败收口，不提交正式 capsule。
4. 成功的 `compaction/summary` 后只有在对应的 `compaction/end` 没有 `error` 时，才将 capsule 写入 `CapsuleStore`。失败 compaction 不落正式记录。
5. `CapsuleStore` 使用 SQLite WAL（Node 22）或 JSONL fallback，记录 `sessionId`、`compactionId`、source seqs、summary/start/end seq、hash、model/provider、time、revision。以 `sessionId:compactionId` 做幂等键，以 session ledger revision 做 CAS。
6. Capsule commit 成功后，默认生成一条 dsh-memory `status=candidate`、`kind=episodic` 记录；scope 使用 cross-session 的稳定 `projectId`，metadata 绑定 `capsuleHash`、`sourceEventIds` 和 `workspaceId`。候选内容只包含 goal、protected constraints、next action、touched files 和 tests 摘要，不包含 raw summary/history。`DSH_COMPACTION_V2_MEMORY_CANDIDATES=0` 可关闭；候选写入失败只记录 warning，不回滚已提交 capsule。

## 显式工具

- `capsule_get`
- `capsule_list`
- `capsule_verify`

这些工具只在 Host 插件激活且被显式调用时运行，不自动读取、不自动注入模型上下文，也不修改当前 UI。

## 激活边界

本目录包含 `cordis.patch.yml`，但本轮不修改 profile/preset。正式接线时，本包只能作为 profile 中原 `compaction-basic` row 的替代项（replacement）挂载；不能把 `dsh-compaction-v2` 与原 `@deepseek-ai/dsh-compaction-basic` 同时挂载，否则会产生两个 compaction service owner 和重复生命周期监听。未作显式 replacement 接线前，当前 compaction 实现不会变化。正式启用前仍需完成 rc.8 profile 兼容性、真实 compaction、回滚和性能验收。

## focused test

```bash
npm test
```

测试覆盖纯函数摘要解析、受保护锚点、路径/命令/数字保留、空/非法/膨胀 fail closed、成功/失败 compaction 事件判定、JSONL/SQLite 重启、CAS 和幂等，以及 candidate 成功、幂等、默认不 recall、禁用和 secret 拒绝不回滚。真实 Harness 事件接线测试需要在不影响当前 profile 的隔离 runtime 中执行。

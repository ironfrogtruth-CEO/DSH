# dsh-memory Host-only v2

本扩展保持原有 Markdown 工具兼容，同时把结构化记录写入本地 SQLite/FTS5。默认数据库为 `DSH_MEMORY_ROOT/memory-v2.sqlite`，也可以用 `DSH_MEMORY_DB` 指定本地文件。`node:sqlite` 不可用时会降级到同路径 `.json` 适配器；不会影响旧 Markdown 读取。

## Markdown + SQLite 双写边界

`memory_save` 和 `memory_checkpoint` 需要同时更新 Markdown 文件与 SQLite 索引。这是两个不同介质，当前实现不是跨介质原子事务：可能出现 Markdown 已写而 SQLite 写入失败，或 SQLite 已写而后续文件操作失败。工具会返回错误，但不会静默声称两边已一致。

诊断与重试：

1. 检查工具返回的 `error`，确认目标 Markdown 文件和 `DSH_MEMORY_DB` 是否可读写；不要删除原始 Markdown。
2. 重新调用同一个写入工具。SQLite 以 `scope + key + content_hash` 去重，重复重试不会重复插入同一结构化记录。
3. 对旧文件使用 `memory_migrate` 或导出 API `importMarkdownMemory` 做显式、幂等的补索引；默认是 dry-run，只有 `confirm=true` 才写 SQLite。
4. 用 `memory_get`、`memory_recall` 的来源字段和 `memory_search` 验证索引是否可见。若只剩 Markdown，内容仍可读取，但不应把它当作 SQLite 已成功写入的证据。

## 外部 Markdown 导入

迁移 root 会先做 canonical/realpath 校验，默认必须位于 `DSH_MEMORY_ROOT` 内；`..`、外部绝对路径和指向外部的 symlink 都会拒绝。仅当维护者明确设置 `DSH_MEMORY_ALLOW_EXTERNAL_ROOT=1` 时，才允许外部导入。导入仍执行 secret/credential 拦截，且不删除源文件。

## 可复用 Host API

`index.js` 导出 `MemoryStore`、`putMemoryRecord`、`searchMemory`、`forgetMemory`、`promoteMemory`、`importMarkdownMemory`、`normalizeMemoryInput` 等；`store.js` 也可通过包的 `./store` export 直接使用。结构化记录带有 scope、kind、source、time、status、confidence、sensitivity、hash、supersedes、version 和 metadata。

candidate 审核通过 `memory_promote` 完成：默认 dry-run，工具层只有在 `dryRun=false` 且 `confirm=true` 时才实际改为 active。每次 candidate → active 会在 `memory_state_events` 追加一条带 reason/source/time 的状态事件；active 重复审核幂等，forgotten/superseded 不允许升级。

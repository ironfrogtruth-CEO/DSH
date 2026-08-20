# dsh-tool-policy

Host-only、可插拔的 `tools/pre-execute` 策略。它只供 headless/隔离 profile 使用；当前 web profile 不接线，不修改 UI 或工具注册表。

## 配置

```json
{
  "mode": "observe",
  "operationMode": "plan",
  "workspaceRoots": ["/work/project"],
  "allow": ["git_status", "git_diff"],
  "ask": ["git_push", "shell_*"],
  "deny": ["git_commit"],
  "baseCwd": "/work/project"
}
```

`mode` 是 `observe` 或 `enforce`，默认 `observe`；observe 只记录策略原判定并调用 `next()`，不会阻断。`operationMode` 支持 `plan/act/debug/review/architect`。

作为 Cordis 函数插件加载时，row 配置通过 `apply(ctx, config)` 的第二个参数传入；它优先于 ctx 上的 service/config fallback。例如：

```js
await apply(ctx, {
  mode: 'enforce',
  operationMode: 'plan',
  workspaceRoots: ['/work/project'],
})
```

- `plan/review/architect`：默认允许 read，拒绝 write/destructive/external/unknown。
- `act/debug`：默认允许 read/write，对 destructive/external/unknown 返回 ask。
- allow/ask/deny 是工具名模式，deny 优先于 ask，ask 优先于 allow；workspace 越界始终 deny。

策略不是 shell 语义分析器：明显的 `rm -rf`、`git reset --hard`、`git clean`、`git commit/push`、网络命令等会被识别；未识别 shell 明确标记为 `unknown`，不会伪装成安全 read。图片、网页正文、memory content 等非结构化内容不改变分类。

## 生命周期与调用

插件通过官方 `tools/pre-execute(exec, next)` waterfall 接入，并用 `ctx.effect` 注册清理。enforce 的 ask/deny 原样返回；没有 approval 服务时由官方 runtime 把 ask 转成 deny。`policy_evaluate` 只评估不执行，`policy_metrics` 和 `policy_list` 只读取本进程内存状态。

# dsh-tool-policy

Host-only、可插拔的 `tools/pre-execute` 策略。它只供 headless/隔离 profile 使用，不修改 UI 或工具注册表；web profile 当前以 observe 模式接线，但保留脱管后台任务硬门禁。

## 配置

```json
{
  "mode": "observe",
  "operationMode": "plan",
  "blockDetachedBackground": true,
  "workspaceRoots": ["/work/project"],
  "allow": ["git_status", "git_diff"],
  "ask": ["git_push", "shell_*"],
  "deny": ["git_commit"],
  "baseCwd": "/work/project"
}
```

`mode` 是 `observe` 或 `enforce`，默认 `observe`；observe 只记录普通策略原判定并调用 `next()`，不会阻断普通工具。只要 `blockDetachedBackground !== false`（默认开启），它仍会硬拒绝 `bash`/`shell` 中的高置信脱管语法，并返回：

`后台任务必须移除脱管语法并使用 run_in_background: true；跨重启请使用 schedule/heartbeat/canonical run`

硬门禁识别命令位置上的 `nohup`、`disown`、`setsid` 和独立后台 `&`；`&&`、`&>`、`>&` 以及引号内的独立 `&` 不会触发 `&` 规则。轻量 shell tokenizer 会递归检查 `bash/sh/zsh -c` 和 `eval` 的命令载荷，因此 `bash -lc "nohup ..."` 不能绕过；`rg 'nohup'`、`printf 'setsid'` 或普通说明文字不会被误伤。即使 `run_in_background: true`，命令中也不能再包一层脱管语法。将 `blockDetachedBackground` 显式设为 `false` 才关闭这条硬门禁。

`operationMode` 支持 `plan/act/debug/review/architect`。

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

标准 `@deepseek-ai/dsh-tool-bash` 的 `enableRunInBackground: true` 会把 `run_in_background: true` 交给 Host 的 `ctx.jobs`；调用方必须保存返回的 job id，并用 `job_output`、`job_list`、`job_kill` 读取、查看和取消。不要用 shell PID 冒充受监督任务。需要跨 Host/大神退出或重启继续的工作，使用真实 session schedule/heartbeat runner 或 canonical ShrimpTank SQLite run；process-local job 不具备跨重启持久性。

策略不是 shell 语义分析器：明显的 `rm -rf`、`git reset --hard`、`git clean`、`git commit/push`、网络命令等会被识别；未识别 shell 明确标记为 `unknown`，不会伪装成安全 read。图片、网页正文、memory content 等非结构化内容不改变分类。

## 生命周期与调用

插件通过官方 `tools/pre-execute(exec, next)` waterfall 接入，并用 `ctx.effect` 注册清理。`detachedBackgroundReason(toolName, args)` 是无副作用的纯分类函数；命中硬门禁时即使通用 policy 为 observe 也直接返回 deny，并以 `hardGate: detached-background` 记入同一套进程内 metrics/recent。enforce 的 ask/deny 原样返回；没有 approval 服务时由官方 runtime 把 ask 转成 deny。`policy_evaluate` 只评估不执行，`policy_metrics` 和 `policy_list` 只读取本进程内存状态。

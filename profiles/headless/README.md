# headless 隔离 profile

这个 profile 是 DeepSeek Harness 新能力的隔离验收入口，默认只组合：

1. `@deepseek-ai/dsh-base`
2. `@deepseek-ai/dsh-headless`
3. `@local/dsh-tool-policy`（首轮 `observe + act`，workspace root 为 `/Users/marcus/.dsh`）
4. `@local/dsh-intelligence`
5. `@local/dsh-memory`
6. `@local/dsh-code-intelligence`
7. `@local/dsh-cross-session`
8. `@local/dsh-frontend-qa`
9. `@local/dsh-evals`

`@local/dsh-compaction-v2` 只作为 profile dependency，由 `cordis.patch.yml` 替换原 `compaction-basic` provider；它不作为独立 bundle 再挂载。rc.8 Loader 不允许用 id patch 直接改 entry name，因此该 patch 会禁用原 `compaction-basic` row，再插入一个 enabled 的本地 replacement row，避免 duplicate loader id。原 provider 不会作为 enabled service 启动。

该 profile 不加载 `dsh-web-app`、client/UI bundle 或浏览器插件。`dsh-base` 中遗留的 web/search rows 也在本 profile 中禁用。当前 Web profile、UI 交互、preset 和 settings 均不受影响。

## 验证

只读配置检查：

```bash
node ~/.dsh/profiles/headless/verify-profile.mjs
```

包含临时 HOME、memory、intelligence、code、cross-session、eval 路径的 Loader smoke：

```bash
node ~/.dsh/profiles/headless/verify-profile.mjs --smoke
```

也可以直接查看：

```bash
~/.dsh/bin/dsh --profile headless --dump-config
```

## 回滚

回滚只需停止使用 `--profile headless` 或删除/移除这个隔离 profile；不要改动 `profiles/web`。恢复 Web 工作流时继续使用原来的 `--profile web`。

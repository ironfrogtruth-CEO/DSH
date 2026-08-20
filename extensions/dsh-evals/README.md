# dsh-evals

`dsh-evals` 是 DeepSeek Harness 的 Host-only、离线、可复现评测 MVP。它只读取允许目录内的 fixture，只写自己的 JSON artifact，不访问网络、不读正式数据、不调用 LLM judge，也没有 client/UI 半部。

## 评测类型

内置最小 fixture 覆盖：

- `compaction-retention`：protected anchor、路径、数字保留和 token budget；
- `memory-retrieval`：Recall@k、MRR、scope leak；
- `task-resume`：Continuation capsule 字段级 resume exactness；
- `code-context`：代码候选文件/符号完整性、路径范围和 token budget；
- `cross-session-ranking`：跨 session 排序、Recall@k、MRR、project scope；
- `frontend-signoff`：DOM、视觉、交互、无障碍检查和 blocking gate。

每个 fixture 都按 `fixture.schema.json` 校验。评测器会尝试动态导入对应模块；模块存在时记录版本并使用其 `evaluateFixture`（若导出），模块缺失时记录明确的 `optionalModule.status: "skipped"`。若 fixture 设置 `requiresModule: true`，模块缺失会把该 case 标记为 `skipped`，不会伪造通过。

## 指标与 Gate

artifact 的 case evidence 会记录：protected anchor/path/number retention、Recall@k、MRR、scope leak、resume exactness、context token budget、candidate completeness honesty、frontend blocking gate、secret leak 和 latency。

`compareEvaluations` 会在以下任一情况出现时返回 `failed`：

- baseline 与 candidate 的任一正确率/质量指标下降；
- candidate 出现 scope leak 或 secret leak；
- 前端 blocking gate 漏放或从通过变为不通过；
- candidate 缺少 baseline case 或变为 skipped。

## Artifact

默认写入 `$DSH_HOME/intelligence/evals/`：

- `runs/<runId>.json`：包含 `runId`、fixtureHash、module versions、started/ended、per-case evidence、score、latency、status、fingerprint；
- `runs.index.jsonl`：轻量索引；
- `compares/<compareId>.json`：baseline/candidate Gate 结果。

运行两次同一 fixture，时间和 runId 可以不同，但 `fixtureHash` 与 `fingerprint` 应保持一致。

## 显式工具

- `eval_run`：运行 allowedRoot 内的 fixture；默认只允许内置 `fixtures/`；
- `eval_compare`：比较两个已写入的 run artifact；
- `eval_list`：列出 run 索引。

工具不会自动注入任何评测结果到模型上下文。fixture 路径会 realpath 后再检查 allowedRoot，路径穿越和网络模块 specifier 会被拒绝。

## 激活边界

`cordis.patch.yml` 只描述可选 Host bundle；本轮不修改 profile/preset。启用后仍只提供显式工具，不影响当前前端 UI 与交互。

## focused test

```bash
npm install
npm test
```

测试覆盖 fixture schema、确定性 hash、六类默认 fixture、optional module skipped、allowedRoot 防穿越、compare 正确率下降、scope leak、secret leak 和 frontend blocking gate omission。

# ADR-0001：事件真源与插件 seam

- 状态：Accepted
- 日期：2026-08-20
- 范围：上下文压缩、长期记忆、跨会话关联以及新增 Host 能力

## 背景

Harness 需要提升长上下文处理、跨会话恢复、任务规划和代码/前端开发能力，但当前前端 UI 与交互已经形成可用合同。把新能力直接塞进 UI bundle 或 fork 核心运行时，会同时放大回归面、升级冲突和回滚成本。

## 决策

### 1. 原始事件是唯一真源

会话消息、工具调用、工具结果、用户约束、任务状态变更和压缩事件写入 append-only event log。Context view、摘要、记忆 capsule、任务 handoff 和检索索引都是派生物，必须带 source event ids、版本、时间和 hash。任何摘要失败都不得覆盖原日志。

### 2. 压缩只替换 active view

压缩器遵守 head + active task + tail 的边界，在安全消息边界裁剪大工具结果，再执行摘要和验证。checkpoint 记录 before/after token、保留/遗忘范围、summary hash、模型、prompt 版本、状态和错误。并发更新使用版本/CAS，失败回退到未压缩 view 或安全截断。

### 3. 记忆使用 SQLite first

第一版记忆层使用 SQLite 表保存 immutable source、episodic ledger、semantic fact、procedural candidate、namespace、ACL、时间有效期和 provenance；FTS5 用于文本检索，向量和图关系作为可重建的 optional index。JIT 读取少量 capsule，不把全量历史或全量 memory 预加载进 system prompt。

### 4. 新能力通过 plugin seam 接入

Host 能力放在独立扩展或独立服务，通过公开工具/存储接口接入 profile。不得 fork、覆盖或改写 `@deepseek-ai/dsh-*` 核心包。新增 Host 扩展不能包含 `client.js`、CSS、JSX/TSX 或导入客户端/UI资源；已有 shrimp-shell 客户端桥接，以及提交 `60f5afd` 引入的 dsh-git 工作区客户端，是明确登记的兼容例外。

### 5. UI 保护是阻断门

UI integrity manifest 记录受保护文件的相对路径和 SHA-256。check 发现新增、缺失或哈希变化即失败。上下文、记忆和任务模块不能通过“顺手修 UI”绕过该门；确需 UI 变更必须走单独批准、基线更新和视觉回归流程。

## 取舍

- 选择 append-only + 派生 view，接受存储增长，换取可审计、可重建和安全回滚。
- 选择 SQLite first，接受首版多跳图检索能力有限，换取本地部署简单和权限边界清晰。
- 选择 plugin seam，接受少量接口适配成本，避免核心升级覆盖本地改动。
- 选择 warning 与 error 分离：危险权限和未启用 session search 先给可见 warning，只有明确启用 `--fail-on-warnings` 或规则配置要求时才升级为失败。

## 后果

所有新模块必须声明输入事件、输出派生物、来源、版本和恢复路径；所有长期记忆写入都要能回答“来自哪条事件、何时有效、谁能读取、如何撤销”。架构护栏和 focused tests 成为交付前最低门槛。

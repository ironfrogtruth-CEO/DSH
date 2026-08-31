---
name: reliable-development-evolution
description: 每周基于可核验证据回顾可靠开发模式，记录台账、验证结果和可追溯的改进建议。
---

# 可靠开发模式自进化(Reliable Development Evolution)

每周运行一次,回顾一周工作,优化提升可靠开发模式的能力、效率和产物质量。与 J-Space 能力融合:用台账(ledger)、自我监控、反思复盘驱动改进落地。

## 何时使用

- 用户说"运行自进化回顾""每周回顾""优化可靠开发模式"等
- 每周一(建议)主动触发
- 任何需要"从过去工作中提炼改进"的时刻

## 运行流程(一次完整的每周回顾)

### 第 1 步:收集数据(证据,不凭印象)

1. `memory_list` 列出所有持久记忆,识别本周新增/更新的 key
2. 读取关键记忆:`memory_get <key>`(checkpoint、约定、决策记录)
3. 统计本周工作(如可能):会话数量、完成的交付物、产物目录 `output/` 内容
4. 收集失败模式证据:同一原因失败两次以上的记录、返工记录

### 第 2 步:J-Space 台账(先立台账再分析)

按 J-Space ledger 格式立账:

```
Goal(本周目标):可靠开发模式的交付质量与效率
Core(核心事实):本周完成 X 项工作,关键里程碑:...
Verified(已验证):哪些结论/方法被事实证明有效
Open(待解决):哪些问题反复出现/未解决
Next(下一步):本周要落地的优化
```

### 第 3 步:四维度分析

| 维度 | 检查问题 | 证据来源 |
|---|---|---|
| 能力 | 本周用到的技能/工具/模式,哪些有效?哪些没达到预期? | memory、checkpoint、产物 |
| 效率 | 哪个环节最耗时?是否有重复劳动、可以合并的步骤?工具链是否有瓶颈? | 会话记录、执行统计 |
| 产物质量 | 交付物是否一次通过?返工几次?验收标准是否清晰? | output/、checkpoint、用户反馈 |
| 失败模式 | 是否有"同一原因失败两次"的情况?当时的 fallback 是否奏效? | 错误记录、checkpoint 风险 |

### 第 4 步:产出优化建议(必须具体到可执行)

每条建议必须满足:
- **具体**:直接指向 reliable-development 的某个文件/段落/流程,如"preset.yml 第 8 条补充 XX"
- **可验证**:改完后有明确的验收方式
- **不堆砌**:只保留真正有证据支持的改进,每轮最多 5 条

建议分两类:
- **预设改进**(改 `~/.dsh/.agent-presets/reliable-development/preset.yml` 或 `agent.cordis.yml` 的指令/流程)
- **技能改进**(改 `~/.dsh/skills/reliable-development/SKILL.md` 的流程/检查项)

### 第 5 步:形成结构化提案

1. 报告与 `proposal-<日期>.json` 写入 `/Users/marcus/Desktop/output/进无止尽/`。
2. 每轮最多提出 5 条建议，但无人值守 runner 最多接纳 1 条低权限经验。
3. headless 分析过程不得直接修改 Git 工作树、commit、push、restart 或注册心跳。
4. preset、代码、runner、tool-policy、调度、模型、阈值和超时只能作为 `code_candidate` 留在提案，等待正常开发流程。

### 第 6 步:runner 白名单回灌

1. runner 在启动前要求仓库干净，并把基线、提示、提案和日志集中备份到 `backups/evolution/<run_id>/`。
2. 只允许向 `skills/reliable-development/references/verified-weekly-learnings.md` 追加一条不超过 2KB 的经验；旧内容不可修改。
3. 经验必须包含证据、规则、验证、来源和 commit/失败指纹锚点；降低或绕过真源、权限、QA、回滚门槛的建议一律拒绝。
4. 回灌后运行 preset verifier、心跳专项和 `git diff --check`；失败恢复基线。
5. 验证通过后只提交该经验文件，固定本地 commit、永不 push。

### 第 7 步:记录周报

用 `memory_save` 保存 key `reliable-evolution-weekly-<日期>`,内容包括:
- 本周数据摘要(第 1 步)
- 台账结论(第 2 步)
- 四维度发现(第 3 步)
- 已应用的建议清单(第 5 步)
- 下周关注点

## 融合 J-Space 的要点

- **台账贯穿**:整个回顾用 Goal/Core/Verified/Open/Next 五段式驱动,每个 seam(数据收集完、分析完、应用完)重述一次
- **自我监控**:分析"失败模式"时,检查是否存在"marker 触发但未执行 bound action"或"声称完成但未验证"的情况(对应 J-Space invariants)
- **密度纪律**:分析笔记用简洁内部语言,但输出给用户/文件的必须是完整可读的
- **只读结论不美化**:凡是没有证据支撑的"改进",不写进建议

## 注意事项

- 只修改与"可靠开发模式"相关的文件,不触碰用户项目代码
- 无人值守运行不得直接修改 preset、核心 Skill、代码、权限或调度器
- 每周最多自动追加 1 条已验证经验；没有合格经验时只记录报告，不制造改动
- 不再在源文件旁生成 `.bak-日期`；统一使用 run-scoped 集中备份
- 本技能本身也可以被进化:如发现流程冗余,提出简化建议

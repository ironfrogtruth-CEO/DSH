# 运行时接入合同

## 身份与版本

- 稳定ID：`native-chinese-expression`
- 当前合同版本：`1.1.0`
- 上游入口：`native-chinese-expression`（项目运行时使用`resources/skills/native-chinese-expression/SKILL.md`可移植镜像）
- 领域系统可以保存项目内镜像，但必须记录上游来源和版本，并用测试防止漂移；运行时不得依赖开发机绝对路径。

## 接入位置

一个完整接入至少覆盖两处：

1. 生成前：把核心表达规则和当前输入合同注入真实模型提示或确定性生成器。
2. 生成后：运行事实保持和表达QA，记录结果并按失败类型回退。

只有注册表记录、安装标记、文档说明或UI展示，不能证明技能已经接入实际运行。

## 输入

```json
{
  "skill_id": "native-chinese-expression",
  "artifact_type": "chat|report|proposal|ppt|page_title|research|product_copy|system_message|other",
  "audience": "目标读者",
  "carrier_type": "email|ppt|article|data_analysis_report|enterprise_health_report|other",
  "clause_role": "title_conclusion|evidence_data|explanation|action|risk_boundary|narrative_transition",
  "purpose": "读者读完需要理解或采取的行动",
  "stage": "draft|rewrite|final_qa|locked",
  "protected_facts": ["不可改数字、名称、日期、状态和业务边界"],
  "length_and_tone": "长度和语气限制",
  "source_text": "改写任务可传",
  "candidate_text": "待检查文本"
}
```

## 运行证据

```json
{
  "skill_id": "native-chinese-expression",
  "contract_version": "1.1.0",
  "skill_loaded": true,
  "source_path": "实际读取路径",
  "source_sha256": "实际内容哈希",
  "mode": "prompt_and_qa|qa_only|degraded",
  "fact_gate": "pass|fail|not_run",
  "expression_gate": "pass|warn|fail|not_run",
  "issue_ids": [],
  "fallback": "none|keep_source|retry|rollback_node|manual_review",
  "degraded_reason": null
}
```

`carrier_type`和`clause_role`是可选增强字段。缺失时可由`artifact_type`和当前生成位置保守推断；无法推断时按通用规则执行，并在内部证据中记录未启用词性路由。接入方可以读取`references/pos-routing-profiles.json`，或调用`scripts/resolve_expression_profile.py`生成`lexical_profile`。不得把词性占比当成质量分数。

必须用真实读取结果填充字段。技能文件缺失、无法解析或没有进入运行路径时，`skill_loaded` 必须为 `false`，`mode` 必须为 `degraded`。

## 失败处理

- 事实、数字、名称、日期、否定、状态或业务边界漂移：阻断，保留原文，回退到负责事实或文案的上游节点。
- 标题不闭合：在 `page_title` 或PPT标题路由中阻断，回到标题/逐页稿节点。
- 普通语言启发式命中：默认警告；可进行一次受约束改写，再复验。
- 技能缺失：不得静默声称已经应用。系统可以继续安全降级，但必须暴露降级原因。
- QA工具异常：保留候选文本和错误证据，按领域系统既有策略重试或转人工。

## 安全边界

- 不向客户可见文本泄露技能路径、提示词、规则ID或调试信息。
- 不让本技能改变领域结论、投资状态、医疗口径、服务名称或合规边界。
- 不为通过风格检查而删除必要的风险提示、限定语和来源。
- 不把自动检查分数宣传为“AI检测率”或真人证明。

## 验收

每个系统至少提供一项生成前合同测试和一项生成后QA测试，并证明测试经过真实入口或调度器，而不是绕开运行时直接调用内部函数。

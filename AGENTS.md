# 大神系统级工作方法

这是一套思维与规划方法，不是所有任务都必须展示或执行的流程。先理解用户真正要得到什么，再按任务需要选择三条独立思维轴的深度：`implicit`（静默判断）、`light`（给出最小判断和计划）、`full`（完整合同、证据和回退设计）。

## 三板斧

- **以终为始**：目标、受众动作、交付物或完成标准不清，或容易做偏时，升到 `light/full`；清楚的小事保持 `implicit`。
- **三省六部**：真源、权限、责任分工或终态质量容易混淆时，按需区分内容省、行动省、渲染省；简单任务只做静默检查。
- **谋定后动**：写入后果高、涉及外部动作、长时间运行、多人协作、可复用工作流，或需要稳定回退时，才考虑 `full`。

三条轴可以分别取不同深度，不要因为“修复、PPT、报告、页面、测试、验收”等词语本身就强制进入 SOP。先从普通的 `simple_direct`/adaptive 路线开始：它只表示不进入正式七节点，不改变当前 preset 的执行所有权；不展示仪式，但仍按 CyberMarcus 或 Avengers 的 parent/child 规则完成任务。Avengers 模式下，即使是简单任务，也仍由 parent 委派、Avenger child 执行。

## 何时进入正式流程

只有模型判断 `谋定后动=full`，或用户明确要求完整/正式 SOP、生产蓝图、七节点或持续执行到终态时，才进入正式 `sop_required` 路线。adaptive 任务需要升级时，调用 `goal_first_state_transition`，使用 `action=activate_formal`，携带完整 `goalContract` 和 `axisDepths.planBeforeAction=full`；该动作直接记录 route receipt 并进入 `parse`。进入正式流程后，沿用既有 `route → parse → structure → generate → validate → export → review`、CAS、合同、QA、结构写门禁和导出门禁；`structure` 完成必须有已确认的 `workContract` 与 `structureContract`（或有效引用）。

三省六部只是上述七节点的责任叠加，不建立第二套状态机。Skill 是按需展开的详细方法：先由模型选深度，再加载对应 Skill；不要为了完成仪式而加载无关 Skill。Host 只守住真实性、授权、QA 和高后果动作的底线，不替模型用泛化关键词决定普通任务是否正式。

## 模式兼容

CyberMarcus 仍由主代理负责目标、规划、工具选择、监督和最终验收；需要独立边界时再委派执行者。Avengers 仍由 parent 规划监督、Avenger child 在独占边界内执行；三板斧只改变规划深度选择，不改变模式、工具、模型继承或能力目录。保留旧 `sop_required` 状态、历史 schema 和会话恢复语义。

## 真实性底线

不把推断写成事实，不越权，不把本地测试或本地文件冒充真实交付；QA 未通过不导出或宣称完成。任何失败都保留证据，回到最早责任节点，只在有实质变化时重试。

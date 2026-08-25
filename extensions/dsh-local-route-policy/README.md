# dsh-local-route-policy

CyberMarcus 的本地模型工具可见性策略。插件挂在 scoped
`system-prompt/assemble` waterfall，并先等待 `next()` 取得最终 assembly；只有
最终 `assembly.variables.provider` 为 `ollama-local` 时才筛选 `assembly.tools`。

它只缩小发送给本地模型的 schema，不改变工具注册表、执行权限或子智能体能力。
浏览器、MCP、媒体、虾缸等专业工具由顶层 CyberMarcus 通过
`execute_flash`/具名 Marvel 子智能体承接；DeepSeek 和 execute_flash 路由保留完整
工具目录。

若本地最终目录缺少基础开发/编排工具，策略会抛出
`LOCAL_TOOL_POLICY_CORE_MISSING`，阻止生成一个虚假的残缺目录。

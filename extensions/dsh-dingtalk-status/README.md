# @local/dsh-dingtalk-status

只读状态投影。官方 `@dingtalk-real-ai/dsh-dingtalk@0.6.2` 负责凭据、Stream、会话、AI Card 和 setup；本扩展只读取其本地脱敏状态，并复用现有 `sidebar.footer.action` 显示连接状态。

状态 API 不返回 Client ID、Client Secret、staffId、conversationId、sessionWebhook、绑定口令、原始状态对象或日志，也不从 UI 写配置、执行命令、发送消息或建立外部连接。

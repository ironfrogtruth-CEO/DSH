# @local/dsh-imessage-bridge

本扩展把 macOS Messages 的一对一 iMessage 收件箱接入 DSH。默认关闭，启用
前必须由本机用户完成 Messages Automation 与 Full Disk Access 授权；扩展不会
修改 TCC 数据库，也不会自动发送测试消息。

边界：

- 只读 `~/Library/Messages/chat.db`，SQLite 使用 `mode=ro`、`query_only=ON`
  与 `busy_timeout`；首次启动只记录最大 `ROWID`，不重放历史。
- 只处理 `service=iMessage`、一对一 chat 和精确白名单消息。该白名单线程是
  大神专用通道，直接发送自然语言即可：没有 route 时自动新建 CyberMarcus
  会话，有 route 时在 2 小时内续聊；`大神：`/`大神:` 仅作为可选的明确
  “新开会话”命令，`结束对话` 清除 route。GUID+ROWID
  幂等，单条最多 8000 字符。相同 Apple ID 的 self-sync 消息只在一对一且
  `chat_identifier` 命中白名单时接受。
- `attributedBody` 由扩展私有 vendor 中固定的 `pytypedstream==0.1.0` 以
  低级事件读取，提取纯文本，不执行或反序列化任意对象。
- 任务通过正式 `/api/session.create` 与 `/api/session.prompt` 接口进入
  `reliable-development`，然后发送 `/permission workspace-write` 命令；远程
  文本包裹为不可信输入安全合同。
- 处理结果与经过 output/、扩展名、大小、realpath 和敏感名称检查的产物由
  静态 AppleScript 交给 Messages。AppleScript 的结果只被称为“已交给
  Messages”，不宣称送达。
- 私有状态只保存水位、GUID、session 映射和回执；不保存完整聊天正文。
- route 只保存 `chatKey/sessionId/lastActiveAt/expiresAt`；心跳提醒只保存
  terminal result watermark，首次观察不回放历史。所有桥回执统一加保留标识
  `【大神】`，接收端在任何 route 状态下都硬拒绝该标识，避免自聊同步形成回环。

`pytypedstream` 使用 LGPL-3.0-or-later，许可证和校验清单在 `vendor/` 中。

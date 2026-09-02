# @local/dsh-dingtalk-subscriptions

大神 Host 侧钉钉订阅控制面。状态只写入 Node 内置 `node:sqlite` 数据库并启用
WAL；没有 JSON 回退。默认数据库为：

`~/.dsh/private/dingtalk-subscriptions/subscriptions.sqlite`

私有目录为 `0700`，数据库、管理员原生令牌和身份 HMAC key 为 `0600`。管理员
令牌文件为 `native-admin-token`，身份密钥文件为 `identity-hmac-key`；机器人
账户只保存 credential ref，不保存 DingTalk 密钥。

## Host API

`DingTalkSubscriptionService` 提供订阅者生命周期、机器人账户、工作区、模式/
模型/推理强度/逐虾授权、选择、绑定挑战、入站鉴权、会话 lineage、周 Token
额度、国务院节假日日历、审计和 outbox 接口。新增、更新、授权、重置等管理
写操作都经过 `system_owner` 检查；管理员调用可以带 `expectedRevision` 做 CAS。

周账期按 `Asia/Shanghai` 的自然周（周一至周日）保存。周末通常禁止使用，
但国务院指定的调休周末工作日允许使用；缺少指定年份日历时 fail closed。

虾匹配只接受消息中经过 NFKC + trim 后完整出现的正式 `display_name`，不支持
别名、slug、搜索或推荐。不存在和未授权统一返回“这只虾不存在或你没有使用权限”。

订阅者运行时策略由 `resolveRuntimePolicy()` 生成：只能读写当前选中的工作区，
禁止访问大神本体、配置、Skill、插件、模式和虾定义，也不能创建或安装新能力。
`createSubscriberAssertion()` 生成供虾缸内部消费的短时 HMAC assertion；claims 使用
epoch seconds，签名为 hex HMAC-SHA256，`accountId/userId` 必须是已同步的
ShrimpTank account/user（不使用钉钉 staffId 兜底）。secret 只来自构造参数/credentials
或本机 `identity-hmac-key`，不入库。

## 原生管理边界

Host 注册 `POST /api/dsh-dingtalk/subscriptions/admin`。请求必须携带
`X-Dashen-Native-Admin`，值必须等于私有目录中的 `native-admin-token`；缺少或
错误令牌返回 `403`。普通浏览器不会获得管理写能力。

管理 action 固定使用以下命名（同一 action envelope 的 `payload` 承载参数）：
`subscriber.list/create/update/suspend/resume/revoke`、`robot.register/list/brand`、
`workspace.list/create/share/grant/revoke`、`entitlement.list/grant/revoke`、
`selection.list/set`、`binding.begin/complete/consume`、`quota.status/reset`、
`registration.begin/status/cancel`、`catalog.list`、`holiday.get/upsert`、
`audit.list`、`outbox.list`。Host 也保留对应的驼峰别名
供单测和内部调用。

`client.js` 是 WebKit 原生桥专用的 ModuleLoader 面板，包含订阅者增删暂停/恢复/撤销、
工作区、模式/模型/推理强度/虾授权与默认组合、Token 重置、扫码状态和审计入口。它只通过：

`window.webkit.messageHandlers.dingtalkSubscriptionAdmin.postMessage(...)`

与 Swift bridge 通信，并监听 `window.__dshDingTalkSubscriptionAdminResult`。没有
原生 bridge 时不注册面板，且不会发起 HTTP 写请求；Node/单测若要使用桥接 helper
请导入 `native-client.js`。

当前官方 Device Registration Flow 只返回机器人凭据，不返回可用于自动改头像的
`unifiedAppId`，也不接收名称、描述或头像字段。因此新机器人会停在
`brand-pending`：面板给出锁定名称、描述和透明 Logo 下载；管理员确认品牌已设置前，
Stream 不启动，订阅者也不能激活。

`ShrimpTankSubscriberClient` 只向 loopback `127.0.0.1:7843` 发起系统同步请求，使用
`X-System-Principal-Token`。订阅者 upsert 会同步当前工作区、周额度和非虾授权 ID；
虾授权在远端回执前保持 pending，outbox processor 负责有界重试。每个 turn 可用
`beginQuotaLease` / `recordQuotaUsage` / `finalizeQuotaLease` 累计多步 usage；没有可靠
usage 的订阅模型会 fail closed。

## 品牌资产

`assets/dashen-bot-avatar.png` 由 `scripts/derive-brand-asset.py` 从虾缸
`mark-dark.png` 机械生成：512×512、RGBA、透明无边框无阴影无文字，虾形居中并保留
橙点。`brand-manifest.json` 和 `.sha256` 可用于机器人创建后的回读校验。未来
订阅机器人固定名称“大神”，描述“大神｜Visible Workflow. Reliable Intelligence.”。

## 测试

在本目录运行：

```bash
node --test index.test.mjs client.test.mjs
```

测试使用临时 SQLite 和注入的测试 HMAC secret，不会写真实凭据或默认生产数据库。

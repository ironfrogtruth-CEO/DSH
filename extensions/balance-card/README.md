# dsbalance — DeepSeek 余额卡片(容器扩展插件)

输入框下方常驻显示当前 DeepSeek 账户余额,低余额(< ¥10)标红,并提供充值入口。

- 数据源: `GET https://api.deepseek.com/user/balance`(官方余额接口,文档: https://api-docs.deepseek.com/zh-cn/api/get-user-balance/ )
- 充值入口: https://platform.deepseek.com/top_up
- 密钥: `~/.dsh/.credentials.yaml` 中 `DEEPSEEK_API_KEY`(经 DSH `credentials` 服务解析,不外泄)
- 刷新: 每 60 秒自动刷新(Client `timer.interval`),进入会话立即加载

## 架构

| 端 | 技术 |
|---|---|
| Host | `credentials.resolve('DEEPSEEK_API_KEY')` → `subprocess.spawn` curl 调余额接口 → `harness.handle('dsbalance.get')` 暴露 RPC |
| Client | `conversation.composer.dock` 插槽(id: dsbalance, order: 5)→ `host.call('dsbalance.get')` 渲染 |

## 加载方式(动态插件,每次 DSH 启动需重新定义)

当前通过会话内 `cordis_define` + `cordis_run` 加载(pluginId: balan-1)。
源码存档: `host.js` / `client.js`。重新加载时把两段源码作为 `code.host` / `code.client` 传入即可。

## 未来固化方式(待做)

将本插件注册为 profile bundle 依赖(`dsh plugin add`),即可随容器自动加载、无需每次手动定义。

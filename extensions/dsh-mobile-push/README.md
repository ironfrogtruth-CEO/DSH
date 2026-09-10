# @local/dsh-mobile-push

会话完成后向手机（iOS Safari/PWA、Android Chrome）发 Web Push（角标 + 声音/震动）的插件侧。

## 架构

```
Host 会话 (turn/end 事件 / 5s 轮询兜底)
        │  写 outbox.jsonl（0600）
        ▼
~/.dsh/private/mobile-push/outbox.jsonl
        │  mobile-push-watcher.py（LaunchAgent，每 5s 消费，字节偏移防重放）
        ▼
pywebpush → 浏览器推送服务 → Service Worker showNotification
```

插件只负责"检测完成 + 写 outbox"；真正加密推送由守护进程完成。

## API

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/mobile-push/config` | GET | `{ok, vapidPublicKey}` |
| `/api/mobile-push/subscribe` | POST | `{endpoint, keys:{p256dh,auth}}`，按 endpoint sha256 去重，存 `subscriptions.json`（0600），返回 `{ok, count}` |
| `/api/mobile-push/test` | POST | 向 outbox 写一条测试任务，watcher 立即向全部订阅发送 |
| `/api/mobile-push/clear` | POST | 打开页面后由移动壳调用，向 outbox 写 `{clear:true}` 行，watcher 清零未读数 |

## 会话完成信号

- 主路径：`ctx.on('session/event', ..., {global:true})`，`event.type === 'turn/end'`（`data.turn` 为回合号）。
- 兜底：`setInterval(5s)` 轮询 `agents.list()` 的 `running → 非running` 转变。
- 两条路径按 `(sessionId, turn)` 在内存中幂等去重；标题来自 `sessionQuery.readTitleSnapshots`（settled-array 合同），否则取最后一条真实用户消息（≤60 字）。

## 文件

- `~/.dsh/private/mobile-push/vapid.json` — VAPID 密钥对（0600，subject `mailto:dashen@yizhiwa.cn`），私钥绝不进 git。
- `~/.dsh/private/mobile-push/subscriptions.json` — 订阅数组（0600）。
- `~/.dsh/private/mobile-push/outbox.jsonl` — 推送任务行（0600），`{id,title,body,path,attempts,createdAt}`；watcher 收到 `clear:true` 行时清零未读。
- `~/.dsh/private/mobile-push/state.json` — watcher 的消费偏移与未读计数。

## 测试

```
node --test index.test.mjs
```

---
name: screen-memory
description: 自动屏幕记忆与原生系统通知的使用方法。当前台应用变化时由 launchd 每 5 分钟静默截图存档（保留最近 24 小时），Agent 可随时回看"刚才/几分钟前屏幕上有什么"；dsh-notify.sh 可弹 macOS 原生通知。Use when the user asks what was on screen recently, wants screen context recall, or asks to send a native desktop notification.
---

# 屏幕记忆与原生通知

## 组件布局

| 路径 | 作用 |
|---|---|
| ~/.dsh/screen-memory/shots/YYYY-MM-DD/HH-MM-SS.png | 截图存档（24h 滚动清理） |
| ~/.dsh/screen-memory/bin/capture.sh | 采集器（launchd com.dsh.screen-memory 每 300s） |
| ~/.dsh/screen-memory/bin/dsh-screen-capture | Swift 截图二进制（TCC 授权挂在它身上） |
| ~/.dsh/screen-memory/blacklist.txt | 敏感应用黑名单（子串匹配，跳过截屏） |
| ~/.dsh/screen-memory/enabled | 存在即启用；删掉/移走即停 |
| ~/.dsh/screen-memory/capture.log | 最近 200 行采集日志 |
| ~/.dsh/bin/dsh-notify.sh [标题] [正文] | 弹原生通知（经 ~/.dsh/apps/DSHNotify.app，带虾缸无边框图标；osascript 兜底） |
| ~/.dsh/bin/dsh-notify-watcher.py | 心跳失败+虾运行终态监听器（launchd com.dsh.notify-watcher 每 60s） |

注意：截图权限挂在 dsh-screen-capture 二进制上，launchd 链路有效；从 DSH 会话 bash 直接调该二进制可能因 TCC 归属（Python.app 链）报 SCREEN_PERMISSION_REQUIRED——属预期，回看历史截图不受影响。

## 回答"刚才屏幕上是什么"

1. `ls -t ~/.dsh/screen-memory/shots/*/` 取最近几张（时间即文件名）。
2. 用 read_image 直接看对应 PNG；时间点对不上就往前翻目录。
3. 注意黑名单时段没有图——查 capture.log 里 SKIP 行可说明原因。

## 发原生通知

```
~/.dsh/bin/dsh-notify.sh "标题" "正文"
```

约定触发点：
- 受管后台 job 完成通知：收到完成回执后调用一次（成功报成功、失败报失败）。
- 虾运行终态和心跳失败由监听器自动弹，无需手动。

## 管理操作

- 暂停采集：`mv ~/.dsh/screen-memory/enabled ~/.dsh/screen-memory/enabled.off`
- 恢复采集：改回来即可。
- 加黑名单：编辑 blacklist.txt 每行一个子串（如 微信、Bank）。
- 重装代理：`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dsh.screen-memory.plist`
- 若日志反复 PENDING permission-not-granted：到 系统设置→隐私与安全性→录屏与系统录音，把 dsh-screen-capture 加回并开启。
- 通知首次运行会请求"允许虾缸发送通知"授权；通知图标由 DSHNotify.app 的 Resources/AppIcon.icns 决定（无边框虾标）。

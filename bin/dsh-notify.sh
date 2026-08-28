#!/bin/bash
# DSH 原生通知 — 用法: dsh-notify.sh [标题] [正文]
# 优先: DSHNotify.app(虾缸图标, UNUserNotificationCenter); 兜底: osascript
title="${1:-大神 Harness}"
msg="${2:-}"
APP="$HOME/.dsh/apps/DSHNotify.app"
QUEUE="$HOME/.dsh/notify-queue.jsonl"

esc() { printf '%s' "$1" | sed 's/\t/\\t/g; s/\n/\\n/g'; }

if [ -d "$APP" ]; then
  printf '%s\t%s\n' "$(esc "$title")" "$(esc "$msg")" >> "$QUEUE"
  open -g -j "$APP" >/dev/null 2>&1 && exit 0
  # 队列写了但 open 失败则清空防重复, 落入兜底
  : > "$QUEUE"
fi
exec osascript -e "display notification \"${msg//\"/\\\"}\" with title \"${title//\"/\\\"}\" sound name \"Glass\""

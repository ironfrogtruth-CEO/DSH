#!/bin/bash
# DSH 自动屏幕记忆采集器 — 由 launchd 每 5 分钟调用
# 行为: 前台应用命中黑名单则跳过; 否则静默截图存档并滚动清理 24h 前的旧图
set -u
ROOT="$HOME/.dsh/screen-memory"
SHOT_DIR="$ROOT/shots"
BIN="$ROOT/bin/dsh-screen-capture"
BLACKLIST="$ROOT/blacklist.txt"
ENABLED_FLAG="$ROOT/enabled"
LOG="$ROOT/capture.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
tail_log() { tail -200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; }

[ -f "$ENABLED_FLAG" ] || { log "SKIP disabled"; exit 0; }

# ---- 前台应用检测（无需 Automation 授权）----
front_asn=$(lsappinfo front 2>/dev/null)
front_app=""
if [ -n "$front_asn" ]; then
  front_app=$(lsappinfo info -only name "$front_asn" 2>/dev/null | sed 's/.*="//;s/"$//')
fi

# ---- 黑名单判断(子串匹配, 忽略大小写) ----
if [ -n "$front_app" ] && [ -f "$BLACKLIST" ]; then
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    case "$pat" in \#*) continue;; esac
    if echo "$front_app" | grep -qiF "$pat"; then
      log "SKIP blacklisted app=$front_app"
      tail_log; exit 0
    fi
  done < "$BLACKLIST"
fi

# ---- 截图 ----
mkdir -p "$SHOT_DIR/$(date +%Y-%m-%d)"
out="$SHOT_DIR/$(date +%Y-%m-%d)/$(date +%H-%M-%S).png"
if "$BIN" --out "$out" >/dev/null 2>&1; then
  log "OK $out app=${front_app:-unknown}"
else
  rc=$?
  if [ "$rc" = "2" ]; then
    log "PENDING permission-not-granted"
  else
    log "FAIL capture rc=$rc"
  fi
  tail_log; exit "$rc"
fi

# ---- 滚动清理: 删除 24h 前的图与空目录 ----
find "$SHOT_DIR" -name "*.png" -mtime +0 -mmin +1440 -delete 2>/dev/null
find "$SHOT_DIR" -mindepth 1 -type d -empty -delete 2>/dev/null
tail_log

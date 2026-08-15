#!/bin/bash
set -u

PROJECT_DIR="/Users/marcus/Desktop/虾缸"
PORT=7843
URL="http://127.0.0.1:$PORT"
LOG="$HOME/.shrimp-tank/server.log"
# 企业健康报告保持独立运行；虾缸页面点击该虾时才按需启动并跳转。
export SHRIMP_TANK_ENTERPRISE_REPORT_ROOT="/Users/marcus/Desktop/平安企康/企业健康报告-本地"
# 新虾的材料、参考模板和知识范围都落到各自领域包，不再依赖全局教材或 PPT 素材目录。
export SHRIMP_TANK_DOMAIN_PACKS_DIR="${SHRIMP_TANK_DOMAIN_PACKS_DIR:-$PROJECT_DIR/data/domain_packs}"

say_err() {
  local tmp
  tmp="$(/usr/bin/mktemp -t ds-msg 2>/dev/null || echo /tmp/ds-msg.txt)"
  printf '%s' "$1" > "$tmp"
  /usr/bin/osascript \
    -e "set f to POSIX file \"$tmp\"" \
    -e "set t to read f as «class utf8»" \
    -e "display dialog t buttons {\"好\"} default button 1 with title \"虾缸开关\" with icon caution" >/dev/null 2>&1
  /bin/rm -f "$tmp"
}

# ---- 快路径：服务已在运行 → 直接开页面（<1 秒） ----
if curl -fsS --max-time 2 "$URL/api/status" >/dev/null 2>&1; then
  /usr/bin/open "$URL"
  exit 0
fi

if [[ ! -d "$PROJECT_DIR" ]]; then
  say_err "找不到项目目录：$PROJECT_DIR"
  exit 1
fi

# 显式解析带依赖的 python3
PY=""
for cand in "$PROJECT_DIR/.venv/bin/python" /usr/local/bin/python3 /usr/bin/python3; do
  if [[ -x "$cand" ]]; then
    PY="$cand"
    break
  fi
done
PY="${PY:-python3}"

cd "$PROJECT_DIR" || exit 1

# 清理冲突端口（仅在端口被占用且不健康时）
if lsof -i :"$PORT" -t >/dev/null 2>&1; then
  lsof -i :"$PORT" -t | xargs kill -9 2>/dev/null
  sleep 2
fi

# 启动服务（后台常驻，日志落盘）
/bin/mkdir -p "$(dirname "$LOG")"
/usr/bin/nohup "$PY" server.py >>"$LOG" 2>&1 &
SERVER_PID=$!

# 健康检查循环（最多 20 秒，0.5 秒间隔）
MAX_RETRIES=40
RETRY_COUNT=0
SUCCESS=false

while [[ $RETRY_COUNT -lt $MAX_RETRIES ]]; do
  if curl -fsS --max-time 1 "$URL/api/status" >/dev/null 2>&1; then
    SUCCESS=true
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    say_err "服务进程意外退出，请查看日志：
$LOG"
    exit 1
  fi
  RETRY_COUNT=$((RETRY_COUNT + 1))
  sleep 0.5
done

if [[ "$SUCCESS" == "true" ]]; then
  /usr/bin/open "$URL"
  exit 0
fi

kill "$SERVER_PID" 2>/dev/null
say_err "服务启动超时（20 秒），请查看日志：
$LOG"
exit 1

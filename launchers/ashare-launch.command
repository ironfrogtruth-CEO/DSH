#!/bin/bash
# A股信号 · 服务启动（在终端内执行，拥有完整文件访问权限）
PORT=18787
URL="http://127.0.0.1:$PORT"
PROJ="/Users/marcus/Desktop/A股/stock-predictor"
VENV="/Users/marcus/Desktop/A股/.venv"
LOG="$HOME/.ashare/server.log"
mkdir -p "$HOME/.ashare"

# 已在运行 → 直接打开页面
if curl -s -o /dev/null --max-time 2 "$URL/api/status" 2>/dev/null; then
  open "$URL"
  exit 0
fi

# 启动服务（借用 sklearn 自带 libomp 解决 lightgbm 依赖）
export DYLD_LIBRARY_PATH="$VENV/lib/python3.11/site-packages/sklearn/.dylibs"
nohup "$VENV/bin/python" "$PROJ/server.py" >> "$LOG" 2>&1 &

# 等待服务就绪（最多 60 秒）
for i in $(seq 1 30); do
  sleep 2
  if curl -s -o /dev/null --max-time 2 "$URL/api/status" 2>/dev/null; then
    break
  fi
done

open "$URL"
echo "A股信号已启动: $URL （日志: $LOG）"
exit 0

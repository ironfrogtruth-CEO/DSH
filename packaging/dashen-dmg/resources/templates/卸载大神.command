#!/bin/bash
set -euo pipefail
SUPPORT_ROOT="$HOME/Library/Application Support/大神"
echo "此操作会停止大神，并把用户运行数据移到废纸篓。"
read -r -p "输入 REMOVE 确认：" answer
if [[ "$answer" != "REMOVE" ]]; then
  echo "已取消。"
  exit 0
fi
if [[ -f "$SUPPORT_ROOT/dsh-home/.portable-runtime" ]]; then
  source "$SUPPORT_ROOT/dsh-home/.portable-runtime"
  "$DASHEN_HOST_SCRIPT" stop || true
fi
if [[ -d "$SUPPORT_ROOT" ]]; then
  stamp=$(date +%Y%m%d-%H%M%S)
  mv "$SUPPORT_ROOT" "$HOME/.Trash/大神-用户数据-$stamp"
  echo "用户数据已移到废纸篓，可在清空前恢复。"
else
  echo "未发现大神用户数据。"
fi
echo "如需删除程序，请把“应用程序”中的大神移到废纸篓。"
read -r -p "按回车键关闭..." _

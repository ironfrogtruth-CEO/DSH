#!/bin/bash
set -u
SUPPORT_ROOT="$HOME/Library/Application Support/大神"
DSH_HOME="$SUPPORT_ROOT/dsh-home"
echo "大神诊断"
echo "系统: $(sw_vers -productVersion)"
echo "芯片: $(uname -m)"
echo "运行目录: $DSH_HOME"
if [[ -f "$DSH_HOME/.portable-runtime" ]]; then
  source "$DSH_HOME/.portable-runtime"
  echo "Node: $DASHEN_NODE"
  "$DASHEN_NODE" --version 2>&1
  "$DASHEN_HOST_SCRIPT" status 2>&1
else
  echo "状态: 尚未完成首次运行时安装"
fi
echo
read -r -p "按回车键关闭..." _

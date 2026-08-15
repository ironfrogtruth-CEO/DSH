#!/bin/zsh
set -u

WORKSPACE="/Users/marcus/Desktop/平安企康/CyberMarcus工作区"
REPAIR_SCRIPT="$WORKSPACE/运行脚本/ensure_hermes_arm64.sh"
CONFIG_SCRIPT="$WORKSPACE/运行脚本/ensure_hermes_local_config.sh"
SKILL_SYNC_SCRIPT="$WORKSPACE/运行脚本/sync_hermes_skills.sh"
OLLAMA_URL="http://127.0.0.1:11434/api/tags"
MPL_CACHE="$WORKSPACE/离线依赖/matplotlib-cache"

say_err() {
  local tmp
  tmp="$(/usr/bin/mktemp -t ds-msg 2>/dev/null || echo /tmp/ds-msg.txt)"
  printf '%s' "$1" > "$tmp"
  /usr/bin/osascript \
    -e "set f to POSIX file \"$tmp\"" \
    -e "set t to read f as «class utf8»" \
    -e "display dialog t buttons {\"好\"} default button 1 with title \"CyberMarcus\" with icon caution" >/dev/null 2>&1
  /bin/rm -f "$tmp"
}

# 本机只有 24GB 统一内存。64K 是 Hermes 工具代理的最低可靠窗口；
# 单并发和有限驻留可避免模型长期占满内存。
/bin/launchctl setenv OLLAMA_CONTEXT_LENGTH 64000
/bin/launchctl setenv OLLAMA_KEEP_ALIVE 10m
/bin/launchctl setenv OLLAMA_NUM_PARALLEL 1
/bin/launchctl setenv OLLAMA_NO_CLOUD 1
/bin/mkdir -p "$MPL_CACHE"
/bin/launchctl setenv MPLCONFIGDIR "$MPL_CACHE"

if [[ -x "$REPAIR_SCRIPT" ]]; then
  "$REPAIR_SCRIPT"
  if [[ "$?" != "0" ]]; then
    say_err "Hermes Apple 芯片组件检查未通过，请打开终端手动运行：
$REPAIR_SCRIPT"
    exit 1
  fi
fi

if [[ -x "$CONFIG_SCRIPT" ]]; then
  "$CONFIG_SCRIPT"
  if [[ "$?" != "0" ]]; then
    say_err "Hermes 本地模型配置校验未通过，请打开终端手动运行：
$CONFIG_SCRIPT"
    exit 1
  fi
else
  say_err "缺少 Hermes 本地模型配置脚本：
$CONFIG_SCRIPT"
  exit 1
fi

if [[ -x "$SKILL_SYNC_SCRIPT" ]]; then
  "$SKILL_SYNC_SCRIPT"
  if [[ "$?" != "0" ]]; then
    say_err "本地 Skill 同步未通过，请打开终端手动运行：
$SKILL_SYNC_SCRIPT"
    exit 1
  fi
fi

if ! /usr/bin/curl -fsS "$OLLAMA_URL" >/dev/null 2>&1; then
  /usr/bin/open -a Ollama
  ollama_ready=0
  for _ in {1..90}; do
    if /usr/bin/curl -fsS "$OLLAMA_URL" >/dev/null 2>&1; then
      ollama_ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ollama_ready" != "1" ]]; then
    say_err "Ollama 启动超时（90 秒）。请打开 Ollama 后重试。"
    exit 1
  fi
fi

if ! /usr/local/bin/ollama show cybermarcus:latest >/dev/null 2>&1; then
  say_err "未找到 CyberMarcus 本地模型别名，请打开终端重新运行本地配置：
$CONFIG_SCRIPT"
  exit 1
fi

/usr/bin/open -a Hermes

sleep 3
exit 0

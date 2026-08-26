#!/bin/zsh
set -u

WORKSPACE="/Users/marcus/Desktop/平安企康/CyberMarcus工作区"
REPAIR_SCRIPT="$WORKSPACE/运行脚本/ensure_hermes_arm64.sh"
CONFIG_SCRIPT="$WORKSPACE/运行脚本/ensure_hermes_local_config.sh"
SKILL_SYNC_SCRIPT="$WORKSPACE/运行脚本/sync_hermes_skills.sh"
OLLAMA_URL="http://127.0.0.1:11434/api/tags"
MODEL_RUNTIME="/Users/marcus/.dsh/scripts/start-local-model-runtime"
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

# 本机只有 24GB 统一内存。32K 覆盖现有 Hermes 会话，同时减少 KV 缓存和换页压力；
# 单并发和有限驻留可避免模型长期占满内存。
/bin/launchctl setenv OLLAMA_CONTEXT_LENGTH 32768
/bin/launchctl setenv OLLAMA_KEEP_ALIVE 10m
/bin/launchctl setenv OLLAMA_NUM_PARALLEL 1
/bin/launchctl setenv OLLAMA_MAX_LOADED_MODELS 1
/bin/launchctl setenv OLLAMA_MODELS "/Users/marcus/Desktop/虾缸/MODEL/ollama/models"
/bin/launchctl setenv OLLAMA_NO_CLOUD 1
/bin/launchctl setenv HF_HOME "/Users/marcus/Desktop/虾缸/MODEL/cache/huggingface"
/bin/launchctl setenv MODELSCOPE_CACHE "/Users/marcus/Desktop/虾缸/MODEL/cache/modelscope"
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

if [[ ! -x "$MODEL_RUNTIME" ]] || ! "$MODEL_RUNTIME"; then
  say_err "本地模型运行时启动失败：
$MODEL_RUNTIME"
  exit 1
fi

if ! /usr/local/bin/ollama show cybermarcus:latest >/dev/null 2>&1; then
  say_err "未找到 CyberMarcus 本地模型别名，请打开终端重新运行本地配置：
$CONFIG_SCRIPT"
  exit 1
fi

/usr/bin/open -a Hermes

sleep 3
exit 0

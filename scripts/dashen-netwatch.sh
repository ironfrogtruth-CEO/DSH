#!/bin/bash
# dashen-netwatch — keep the dashen mobile gateway reachable across network changes.
#
# Rebuilt 2026-09-09 from ~/.dsh/logs/dashen-netwatch.log behavior and the
# dashen-cloudflared-tunnel-ops memory after the original file was lost from
# ~/.dsh/scripts/. Behavior contract:
#
# - Poll the default route every 5s. On network restore (down -> up) wait 4s,
#   then hot-reload mihomo (treats "switch subscription" after reconnect) and
#   probe the public tunnel. On a route change while up, do the same.
# - Tunnel probe hits https://dashen.yizhiwa.cn/ ; 401 from oauth2-proxy is
#   the healthy signal. Three consecutive failures -> kickstart the
#   cn.yizhiwa.dashen.cloudflared LaunchAgent, then keep probing with a 120s
#   cooldown between kickstarts.
# - Logs to ~/.dsh/logs/dashen-netwatch.log. Never touches public/private
#   routes, VPN settings, or tokens.

LOG_FILE="$HOME/.dsh/logs/dashen-netwatch.log"
MIHOMO_API="http://127.0.0.1:9097"
MIHOMO_CFG="$HOME/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/config.yaml"
PUBLIC_URL="https://dashen.yizhiwa.cn/"
CLOUDFLARED_LABEL="cn.yizhiwa.dashen.cloudflared"
POLL_INTERVAL=5
RESTORE_GRACE=4
PROBE_TRIES=3
PROBE_GAP=10
PROBE_TIMEOUT=8
KICKSTART_COOLDOWN=120

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG_FILE"; }

mihomo_secret() {
  # Read the runtime secret from the Clash Verge config; fall back to empty.
  sed -n 's/^[[:space:]]*secret:[[:space:]]*//p' "$MIHOMO_CFG" 2>/dev/null | head -1 | tr -d '"'"'"''
}

current_route() {
  # "interface-gateway" for the active default route, or empty when offline.
  route -n get default 2>/dev/null | awk '
    /interface:/ { iface=$2 }
    /gateway:/   { gw=$2 }
    END { if (iface != "") print iface "-" gw }
  '
}

mihomo_reload() {
  local secret code
  secret="$(mihomo_secret)"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    -X PUT "${MIHOMO_API}/configs?force=true" \
    -H "Authorization: Bearer ${secret}" \
    -H 'Content-Type: application/json' \
    -d '{"path":"","payload":""}')
  if [ "$code" = "000" ]; then
    log "mihomo API 不可达, 跳过热重载"
  else
    log "mihomo 热重载 -> HTTP $code"
  fi
}

tunnel_probe() {
  # Healthy when oauth2-proxy answers (401) or anything is served (<500).
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" "$PUBLIC_URL")
  case "$code" in
    200|301|302|303|307|308|401|403|404) return 0 ;;
    *) return 1 ;;
  esac
}

kickstart_tunnel() {
  /bin/launchctl kickstart -k "gui/$(id -u)/${CLOUDFLARED_LABEL}"
}

LAST_ROUTE=""
LAST_KICKSTART=0
FAILURES=0

log "netwatch 启动 (rebuilt 2026-09-09)"

while true; do
  route="$(current_route)"

  if [ -n "$route" ] && [ -z "$LAST_ROUTE" ]; then
    log "网络恢复: [$route], ${RESTORE_GRACE}s 后修复"
    sleep "$RESTORE_GRACE"
    mihomo_reload
  elif [ -n "$route" ] && [ "$route" != "$LAST_ROUTE" ]; then
    log "默认路由变化: $LAST_ROUTE -> $route, 修复"
    mihomo_reload
  elif [ -z "$route" ] && [ -n "$LAST_ROUTE" ]; then
    log "默认路由丢失 (原 $LAST_ROUTE), 等待恢复"
  fi
  LAST_ROUTE="$route"

  if [ -z "$route" ]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  if tunnel_probe; then
    if [ "$FAILURES" -ge "$PROBE_TRIES" ]; then
      log "隧道已恢复可用"
    fi
    FAILURES=0
    LAST_KICKSTART=0
    sleep "$POLL_INTERVAL"
    continue
  fi

  for try in $(seq 1 "$PROBE_TRIES"); do
    log "隧道探测失败 ($try/$PROBE_TRIES)"
    sleep "$PROBE_GAP"
    tunnel_probe && break
  done

  if tunnel_probe; then
    FAILURES=0
    LAST_KICKSTART=0
    continue
  fi
  FAILURES=$((FAILURES + PROBE_TRIES))

  now=$(date +%s)
  elapsed=$((now - LAST_KICKSTART))
  if [ "$LAST_KICKSTART" -ne 0 ] && [ "$elapsed" -lt "$KICKSTART_COOLDOWN" ]; then
    remaining=$((KICKSTART_COOLDOWN - elapsed))
    log "隧道仍不可用, 重启冷却中 (${remaining}s/${KICKSTART_COOLDOWN}s)"
    sleep "$POLL_INTERVAL"
    continue
  fi

  log "cloudflared 隧道探测连续失败 ${FAILURES} 次, kickstart 现有 LaunchAgent"
  kickstart_tunnel
  LAST_KICKSTART=$(date +%s)
  FAILURES=0
done

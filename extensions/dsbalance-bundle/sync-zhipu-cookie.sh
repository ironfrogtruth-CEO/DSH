#!/usr/bin/env bash
# sync-zhipu-cookie.sh — 从本机 Chrome 读取 bigmodel.cn 登录态, 更新 ~/.dsh/.credentials.yaml
# 用途: GLM 余额卡片数据源(BIGMODEL_WEB_TOKEN)过期后重新同步。
# 前提: 用户在默认 Chrome 的 Default Profile 里已登录 open.bigmodel.cn。
set -euo pipefail

DB_SRC="$HOME/Library/Application Support/Google/Chrome/Default/Cookies"
TMP_DB="/tmp/chrome-cookies-audit.db"
CRED="$HOME/.dsh/.credentials.yaml"

cp "$DB_SRC" "$TMP_DB" && chmod 600 "$TMP_DB"

JWT=$(node - <<'EOF'
const { execFileSync } = require("child_process");
const crypto = require("crypto"), fs = require("fs");
const pw = execFileSync("security", ["find-generic-password","-w","-s","Chrome Safe Storage"], {encoding:"utf8"}).trim();
const key = crypto.pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
const json = execFileSync("sqlite3",
  ["file:/tmp/chrome-cookies-audit.db?mode=ro&immutable=1","-json",
   `SELECT name, lower(hex(encrypted_value)) AS eh FROM cookies WHERE host_key LIKE '%bigmodel%' AND name='bigmodel_token_production' ORDER BY expires_utc DESC LIMIT 1`],
  {maxBuffer: 1<<22}).toString();
const rows = JSON.parse(json);
if (!rows.length) { console.error("no bigmodel_token_production cookie found — 请先在 Chrome 登录 open.bigmodel.cn"); process.exit(1); }
const enc = Buffer.from(rows[0].eh, "hex").subarray(3);
const d = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
d.setAutoPadding(false);
const out = Buffer.concat([d.update(enc), d.final()]).toString("latin1");
// 首块因 IV 轮换可能有噪声, 但 JWT 位于末段且带合法 PKCS7 填充, 正则提取即可:
const m = out.match(/eyJhbGciOiJIUzUxMiJ9\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
if (!m) { console.error("JWT not found in decrypted payload"); process.exit(1); }
console.log(m[0]);
EOF
)

test -n "$JWT"
# 幂等更新: 已有行则替换, 否则追加
if grep -q "^  BIGMODEL_WEB_TOKEN:" "$CRED"; then
  sed -i '' -e "s|^  BIGMODEL_WEB_TOKEN: .*|  BIGMODEL_WEB_TOKEN: $JWT|" "$CRED"
else
  printf '  BIGMODEL_WEB_TOKEN: %s\n' "$JWT" >> "$CRED"
fi
echo "BIGMODEL_WEB_TOKEN synced (${#JWT} chars). Host 重启后生效; GUI 余额卡片将显示真实余额。"

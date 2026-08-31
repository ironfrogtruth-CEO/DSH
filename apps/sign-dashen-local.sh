#!/usr/bin/env bash
set -euo pipefail

app_path="${1:-/Applications/大神.app}"
plist_path="$app_path/Contents/Info.plist"
expected_id="local.dsh.dashen"

if [[ ! -d "$app_path" || ! -f "$plist_path" ]]; then
  echo "大神 App 不存在或结构不完整: $app_path" >&2
  exit 1
fi

bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist_path")"
if [[ "$bundle_id" != "$expected_id" ]]; then
  echo "拒绝签名非大神 App: bundle id=$bundle_id" >&2
  exit 1
fi

# An ad-hoc signature normally falls back to a cdhash requirement. That hash
# changes after every rebuild and makes macOS forget ScreenCapture permission.
# Pin the designated requirement to the stable bundle identifier instead.
requirement='=designated => identifier "local.dsh.dashen"'
codesign --force --deep --sign - --identifier "$expected_id" --requirements "$requirement" "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"

actual_requirement="$(codesign -d -r- "$app_path" 2>&1)"
if [[ "$actual_requirement" != *'designated => identifier "local.dsh.dashen"'* ]]; then
  echo "大神 App 的稳定签名要求未生效" >&2
  exit 1
fi

echo "大神 App 已使用稳定本地签名要求: $expected_id"

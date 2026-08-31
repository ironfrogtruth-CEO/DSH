#!/bin/bash
set -euo pipefail

PACKAGE_ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="${1:-$PACKAGE_ROOT/build/stage/大神.app}"
RESOURCES="$APP/Contents/Resources"
SOURCE_ROOT="${DASHEN_SOURCE_ROOT:-/Users/marcus/.dsh}"

test -x "$APP/Contents/MacOS/大神"
test -x "$RESOURCES/runtime/node-arm64/bin/node"
test -x "$RESOURCES/runtime/node-x86_64/bin/node"
test -f "$RESOURCES/payload/dsh-home/install/node_modules/@deepseek-ai/dsh/lib/bin.js"
lipo "$APP/Contents/MacOS/大神" -verify_arch arm64 x86_64
codesign --verify --deep --strict "$APP"
"$RESOURCES/runtime/node-arm64/bin/node" "$PACKAGE_ROOT/scripts/secret-scan.mjs" "$SOURCE_ROOT/.credentials.yaml" "$RESOURCES/payload/dsh-home"
arch -x86_64 "$RESOURCES/runtime/node-x86_64/bin/node" -e "const {createRequire}=require('module');const r=createRequire('$RESOURCES/payload/dsh-home/install/package.json');r('sharp');r('koffi');r('node-pty')"
echo "bundle-validation-ok"
